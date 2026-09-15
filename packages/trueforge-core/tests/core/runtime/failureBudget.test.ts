import type { AgentCapability } from '../../../src/core/capabilities/AgentCapability';
import type {
  AgentContextProcessorOutput,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { ASK_USER_QUESTION_TOOL_NAME, askUserQuestion } from '../../../src/core/capabilities/builtins/AskUserQuestion';
import { dynamicSubAgents } from '../../../src/core/capabilities/builtins/DynamicSubAgents';
import { ToolPreDispatchError } from '../../../src/core/errors';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolCallSignature } from '../../../src/core/mcp/executeToolCalls';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import {
  InternalEventType,
  type AgentThreadExecutionEvent,
  type ContextMessage,
} from '../../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import { identicalCallSignatureMarker } from '../../../src/core/runtime/contextUtils';
import type { CreateDynamicSubAgentThread } from '../../../src/core/runtime/CreateDynamicSubAgentThread';
import { EXITED_NOTE } from '../../../src/core/sandbox/execResultSemantics';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * A toolset with two tools: `write`, which always succeeds, and `run`, which fails the way the
 * caller decides: by returning an error result (it ran and failed) or by throwing before
 * dispatch (it never ran). Shaped after a real session where the sandbox was down: the model
 * rewrote a script and re-ran it for twenty rounds while no counter fired.
 */
function makeWorkspaceToolSet({
  runFailure,
  hostOwned,
}: {
  runFailure: 'nonzero' | 'never_ran';
  hostOwned: boolean;
}): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [
      { name: 'write', description: 'Write a file', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'run', description: 'Run a command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'lookup', description: 'Look something up', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: hostOwned ? 'truefoundry-system' : 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(params => {
    if (params.name !== 'run') {
      return Promise.resolve(toolResultResponse({ text: 'ok' }));
    }
    if (runFailure === 'never_ran') {
      return Promise.reject(new ToolPreDispatchError("Tool 'run' could not be prepared for execution"));
    }
    return Promise.resolve(toolResultResponse({ text: 'Traceback: boom', isError: true }));
  });
  return toolSet;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream({
  id,
  name,
  args,
}: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
  yield {
    id: `chunk-${id}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** Same as {@link toolCallStream} but for one assistant message making several tool calls at once. */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* multiToolCallStream(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = calls.map(({ id, name, args }) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }));
  yield {
    id: 'chunk-mixed-batch',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function runThreadInstance(
  toolSet: IToolSet,
  create: jest.Mock,
  toolCallMemo?: ReturnType<AgentThread['toSnapshot']>['tool_call_memo'],
  isRequestContinuation?: boolean,
): Promise<{ events: unknown[]; thread: AgentThread }> {
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo,
    isRequestContinuation,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    },
    context: [{ role: 'user', content: 'What is the latest Qwen model?' }],
  });
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return { events, thread };
}

async function runThread(toolSet: IToolSet, create: jest.Mock): Promise<unknown[]> {
  return (await runThreadInstance(toolSet, create)).events;
}

const runCall = (round: number) =>
  toolCallStream({ id: `run-${String(round)}`, name: 'run', args: { command: `python3 attempt${String(round)}.py` } });

describe('failure budget', () => {
  it('stops after five consecutive batches that ran and failed, and nudges after three', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Distinct arguments every time, so no narrower repeat guard can claim the stop.
      return round <= 6 ? runCall(round) : finalAnswerStream();
    });

    const events = await runThread(toolSet, create);

    expect(toolSet.callTool).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('five consecutive tool calls that all failed'),
        // A deliberate host guard stop, not an unrecoverable model/provider error: TurnHandle
        // maps a root_agent_error with no handoff_cause to 'fatal_error', so this must be set.
        handoff_cause: 'iteration_limit',
      }),
    );
    // The request that follows the third failure (index 3) carries the nudge; the one before it
    // (after only two failures) must not.
    expect(JSON.stringify(requests[2]?.messages)).not.toContain('consecutive tool batches have failed');
    expect(JSON.stringify(requests[3]?.messages)).toContain('3 consecutive tool batches have failed');
  });

  it('counts a run that never ran and a run that failed as one streak', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      if (round > 6) return finalAnswerStream();
      // Odd rounds run and fail; even rounds never run (a tool the host does not know).
      return round % 2 === 1
        ? runCall(round)
        : toolCallStream({ id: `ghost-${String(round)}`, name: `ghost_tool_${String(round)}`, args: {} });
    });

    const events = await runThread(toolSet, create);

    expect(create).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('five consecutive tool calls that all failed'),
      }),
    );
  });

  it('does not stop a streak that is broken by a call that worked', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      if (round > 8) return finalAnswerStream();
      return round % 3 === 0
        ? toolCallStream({
            id: `write-${String(round)}`,
            name: 'write',
            args: { path: 'a.py', content: `v${String(round)}` },
          })
        : runCall(round);
    });

    const events = await runThread(toolSet, create);

    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });
});

describe('failed-batch nudge', () => {
  it('nudges once at the third consecutive failure, continues to the fourth without resending, then stops at the fifth', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 6 ? runCall(round) : finalAnswerStream();
    });

    const events = await runThread(toolSet, create);

    const noteText = 'consecutive tool batches have failed';
    expect(JSON.stringify(requests[2]?.messages)).not.toContain(noteText);
    expect(JSON.stringify(requests[3]?.messages)).toContain('3 consecutive tool batches have failed');
    // The fourth failure does not resend the note: it is still present in context (nothing
    // compacted it away), so the durable guard (hasSentHostNoteThisTurn) finds it and skips.
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(noteText)).toHaveLength(2); // one occurrence splits into two parts
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('ignoring the earlier host note'),
        handoff_cause: 'iteration_limit',
      }),
    );
  });

  it('resets the nudge state when the streak breaks, so a later streak nudges again', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three failures (nudged at the third), one success (resets the streak and its nudge
      // state), then three more failures that must be nudged again rather than reading as
      // already sent from the marker left by the first streak.
      if (round <= 3) return runCall(round);
      if (round === 4) {
        return toolCallStream({ id: 'write-reset', name: 'write', args: { path: 'a.py', content: 'reset' } });
      }
      if (round <= 7) return runCall(round);
      return finalAnswerStream();
    });

    const events = await runThread(toolSet, create);

    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    const noteText = 'consecutive tool batches have failed';
    // Both streaks' notes survive into the final history, as two distinct occurrences.
    expect(finalMessages.split(noteText)).toHaveLength(3);
  });

  it('re-sends the nudge after compaction removes it, and still stops at the fifth failure', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: true });
    const noteText = 'consecutive tool batches have failed';
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 5 ? runCall(round) : finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    // Compacts away on the preLLM pass right after the third failure's nudge landed in context,
    // and before the fourth failure's request is built.
    const compaction = new CompactAwayOnNthCall(4);
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Run the failing script.' }],
      capabilities: [{ preLLMProcessors: [compaction] }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(toolSet.callTool).toHaveBeenCalledTimes(5);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error: expect.stringContaining('five consecutive tool calls that all failed'),
        handoff_cause: 'iteration_limit',
      }),
    );
    // Compaction wiped the note before the fourth failure's request was built, so that request
    // must not carry it.
    expect(JSON.stringify(requests[3]?.messages)).not.toContain(noteText);
    // The fourth failure still gets a note in the request that follows it: the durable guard
    // found no note left in context (compaction erased it), so it is re-sent.
    expect(JSON.stringify(requests[4]?.messages)).toContain(noteText);
  });

  it('nudges and stops at the failed-batch threshold even when subsequent batches are blocked before dispatch', async () => {
    // Regression for Bug 1: the failed-batch warning must not be suppressed just because a
    // later batch is a no-progress batch (blocked before dispatch). After two executed
    // failures followed by three blocked batches, the failure count reaches five while the
    // blocked count reaches only three, so the first note (failed-batch) is appended
    // immediately before the failure stop and no suppression should prevent the model from
    // seeing it.
    const toolSet = makeMockIMCPServer({
      name: 'workspace',
      preload: true,
      tools: [{ name: 'run', description: 'Run a command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(params => {
      // Rounds 1-2: run and fail with nonzero exit code (executed failures)
      // Rounds 3-5: hallucinated tools that don't exist (blocked before dispatch)
      if (!params || params.name !== 'run') {
        return Promise.reject(new ToolPreDispatchError('Tool not found'));
      }
      return Promise.resolve(toolResultResponse({ text: 'Traceback: boom', isError: true }));
    });

    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round <= 2) {
        // Executed failures: call runs but fails with an error
        return runCall(round);
      }
      if (round <= 5) {
        // Blocked batches: hallucinated tool that never runs
        return toolCallStream({
          id: `blocked-${String(round)}`,
          name: `nonexistent_tool_${String(round)}`,
          args: { command: 'something' },
        });
      }
      return finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Run the script.' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // Verify the stop occurred
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('five consecutive tool calls that all failed'),
        handoff_cause: 'iteration_limit',
      }),
    );

    // Most importantly: the failed-batch note should appear in context before the stop,
    // not be suppressed by the no-progress batch classification
    const failedBatchNoteText = 'consecutive tool batches have failed';
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(failedBatchNoteText);
  });
});

/** A single `run` tool that always succeeds, for tests that only care about the repeat count. */
function makeSucceedingRunToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [{ name: 'run', description: 'Run a command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'truefoundry-system',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
  return toolSet;
}

/**
 * A minimal `PreLLMAgentContextProcessor` standing in for `ContextCompaction`: on a chosen
 * invocation it overwrites the entire context with a summary, dropping every internal system
 * message (including an identical-call nudge), exactly as real compaction does (it explicitly
 * skips internal system messages when building the summary it replaces context with).
 */
class CompactAwayOnNthCall implements PreLLMAgentContextProcessor {
  private calls = 0;

  constructor(private readonly compactOnCall: number) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
  async *processPreLLM(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    this.calls += 1;
    if (this.calls !== this.compactOnCall) {
      return;
    }
    const summaryContext: ContextMessage[] = [{ role: 'assistant', content: 'Summary of the conversation so far.' }];
    yield {
      type: EventType.AGENT_CONTEXT_OVERWRITE,
      id: newEventId(),
      created_at: new Date().toISOString(),
      reason: 'compaction',
      context: summaryContext,
      current_context_usage: getEmptyCurrentContextUsage(),
      usage: getEmptyUsage(),
    };
  }
}

describe('repeat budget', () => {
  const rewriteThenRerun = (round: number, rounds: number) => {
    if (round > rounds) return finalAnswerStream();
    return round % 2 === 1
      ? toolCallStream({
          id: `write-${String(round)}`,
          name: 'write',
          args: { path: 'qwen_search.py', content: `attempt ${String(round)}` },
        })
      : toolCallStream({
          id: `run-${String(round)}`,
          name: 'run',
          args: {
            intent: `Run the search script, try ${String(round)}`,
            command: 'cd /opt/tf/workspace && python3 qwen_search.py',
          },
        });
  };

  it('nudges on the second identical call instead of stopping the turn', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'never_ran', hostOwned: true });
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // rounds=4: write, run(1st), write, run(2nd) — the second `run` is the nudge point.
      return rewriteThenRerun(round, 4);
    });

    const events = await runThread(toolSet, create);

    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    // The request that follows the second identical `run` call carries the nudge in context;
    // it is host-authored context, not a client-visible output event (asserted above by the
    // absence of any 'error' status, and below by there being no separate event for it).
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('You already made this exact run call in this request');
  });

  it("nudges each argument variant on its own second occurrence, and still stops at that variant's fourth call", async () => {
    // Regression for the Qodo finding on this PR: dedupe, the durable "already sent" check, and
    // the deferred/pending list must all key off the full call signature (tool plus canonical
    // arguments), not the tool name alone. Otherwise the first argument variant's nudge silently
    // marks every other variant of the same tool as already warned. Exact sequence from the
    // finding: run({a:1}) twice, then run({a:2}) four times. The a:2 variant must get its own
    // nudge at its own second occurrence, and the turn must still stop at a:2's fourth occurrence.
    // A succeeding tool, not a failing one: consecutive_failed_batches has its own, lower stop
    // threshold (FAILED_BATCH_STOP_AT), and six straight failures would trip that budget first,
    // masking the repeat-budget behavior this test exists to check.
    const toolSet = makeSucceedingRunToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      const args = round <= 2 ? { a: 1 } : { a: 2 };
      return toolCallStream({ id: `run-${String(round)}`, name: 'run', args });
    });

    const events = await runThread(toolSet, create);

    expect(create).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('the same run call four times in this request'),
        handoff_cause: 'iteration_limit',
      }),
    );

    const markerFor = (args: Record<string, unknown>): string =>
      identicalCallSignatureMarker(
        toolCallSignature({
          function: { name: 'run', arguments: JSON.stringify(args) },
          tool_info: { type: 'truefoundry-system' },
        } as unknown as Parameters<typeof toolCallSignature>[0]),
      );
    const variant1Ref = `[ref:${markerFor({ a: 1 })}]`;
    const variant2Ref = `[ref:${markerFor({ a: 2 })}]`;
    expect(variant1Ref).not.toBe(variant2Ref);

    // a:1's nudge is decided alongside its own second occurrence (round 2) and so first appears
    // in the request sent for round 3 (index 2), never before.
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(variant1Ref);
    expect(JSON.stringify(requests[2]?.messages)).toContain(variant1Ref);

    // a:2's nudge is decided alongside its own second occurrence (round 4) and so first appears
    // in the request sent for round 5 (index 4), never before, and never conflated with a:1's.
    expect(JSON.stringify(requests[3]?.messages)).not.toContain(variant2Ref);
    expect(JSON.stringify(requests[4]?.messages)).toContain(variant2Ref);

    // Both nudges are distinct and both survive into the final history.
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages).toContain(variant1Ref);
    expect(finalMessages).toContain(variant2Ref);
  });

  it('lets three identical calls through, nudging only once', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'never_ran', hostOwned: true });
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // rounds=6: write, run(1st), write, run(2nd, nudged), write, run(3rd) — still no stop.
      return rewriteThenRerun(round, 6);
    });

    const events = await runThread(toolSet, create);

    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    // The nudge fires once, at the second occurrence, and is not repeated at the third: it is
    // still present in context at that point (nothing compacted it away), so the durable guard
    // (hasSentIdenticalCallNudgeThisTurn) finds it and skips re-sending. Context accumulates, so
    // every request after the nudge carries it forward; what must not happen is a second copy
    // landing in the final, full history. See the compaction test below for the case where the
    // nudge is no longer present and must be re-sent.
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    const nudgeText = 'You already made this exact run call in this request';
    expect(finalMessages.split(nudgeText)).toHaveLength(2); // one occurrence splits into two parts
  });

  it('stops the fourth identical call even when writes with new content sit between them', async () => {
    const toolSet = makeWorkspaceToolSet({ runFailure: 'never_ran', hostOwned: true });
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      // rounds=16: run occurs on rounds 2, 4, 6, 8 — the fourth stops the turn.
      return rewriteThenRerun(round, 16);
    });

    const events = await runThread(toolSet, create);

    expect(create).toHaveBeenCalledTimes(8);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('the same run call four times in this request'),
        // A deliberate host guard stop, not an unrecoverable model/provider error: TurnHandle
        // maps a root_agent_error with no handoff_cause to 'fatal_error', so this must be set.
        handoff_cause: 'iteration_limit',
      }),
    );
  });

  it("does not count identical calls from an earlier turn toward this turn's repeat budget", async () => {
    // Regression for DEFECT 2: toolCallMemo.callSignatures is durable and can be hydrated
    // from a snapshot written by an earlier turn (or, as here, an earlier AgentThread
    // instance continuing the same durable memo — the harness builds one instance per
    // turn). The stop decision must count only calls made in the current turn, or a call
    // repeated once in turn 9 falsely reports "four times in this request" because three
    // earlier, unrelated occurrences from turn 3 are still in the hydrated map.
    const toolSet = makeWorkspaceToolSet({ runFailure: 'never_ran', hostOwned: true });
    const repeatedArgs = {
      intent: 'Run the search script',
      command: 'cd /opt/tf/workspace && python3 qwen_search.py',
    };

    // "Turn 3": the same call three times, which stays under the four-call stop threshold.
    let earlierRound = 0;
    const earlierCreate = jest.fn(() => {
      earlierRound += 1;
      if (earlierRound > 3) return finalAnswerStream();
      return toolCallStream({ id: `run-earlier-${String(earlierRound)}`, name: 'run', args: repeatedArgs });
    });
    const { events: earlierEvents, thread: earlierThread } = await runThreadInstance(toolSet, earlierCreate);
    expect(earlierEvents).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    const hydratedToolCallMemo = earlierThread.toSnapshot().tool_call_memo;
    expect(hydratedToolCallMemo?.call_signatures).toEqual([expect.objectContaining({ count: 3 })]);

    // "Turn 9": a fresh AgentThread instance hydrated from that durable memo makes the
    // same call exactly once. Before the fix this summed to 4 against the hydrated count
    // and falsely stopped the turn.
    let laterRound = 0;
    const laterCreate = jest.fn(() => {
      laterRound += 1;
      if (laterRound > 1) return finalAnswerStream();
      return toolCallStream({ id: 'run-later-1', name: 'run', args: repeatedArgs });
    });
    const { events: laterEvents } = await runThreadInstance(toolSet, laterCreate, hydratedToolCallMemo);

    expect(laterEvents).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(laterEvents.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('counts identical calls made on both sides of an approval pause toward the same request', async () => {
    // Regression: an approval continuation rebuilds AgentThread from the preceding
    // snapshot without a new user message (same rationale as the DEFECT 2 test above —
    // the harness builds a fresh instance per continuation, not per turn). Two identical
    // calls before the pause (which reach the nudge point) plus two after must still stop
    // at four, because all four belong to the same in-flight request.
    const toolSet = makeWorkspaceToolSet({ runFailure: 'never_ran', hostOwned: true });
    const repeatedArgs = {
      intent: 'Run the search script',
      command: 'cd /opt/tf/workspace && python3 qwen_search.py',
    };

    // Before the pause: the same call twice, which stays under the four-call stop threshold
    // (and reaches the nudge point).
    let beforeRound = 0;
    const beforeCreate = jest.fn(() => {
      beforeRound += 1;
      if (beforeRound > 2) return finalAnswerStream();
      return toolCallStream({ id: `run-before-${String(beforeRound)}`, name: 'run', args: repeatedArgs });
    });
    const { events: beforeEvents, thread: beforeThread } = await runThreadInstance(toolSet, beforeCreate);
    expect(beforeEvents).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    const pausedToolCallMemo = beforeThread.toSnapshot().tool_call_memo;
    expect(pausedToolCallMemo?.call_signatures).toEqual([expect.objectContaining({ count: 2 })]);

    // After the pause: a fresh AgentThread instance hydrated from that same request's
    // durable memo, marked as a continuation, makes the same call again until it stops —
    // a third time (no nudge; already sent before the pause) and a fourth time (stop).
    let afterRound = 0;
    const afterCreate = jest.fn(() => {
      afterRound += 1;
      return toolCallStream({ id: `run-after-${String(afterRound)}`, name: 'run', args: repeatedArgs });
    });
    const { events: afterEvents } = await runThreadInstance(toolSet, afterCreate, pausedToolCallMemo, true);

    expect(afterCreate).toHaveBeenCalledTimes(2);
    expect(afterEvents).toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('the same run call four times in this request'),
        handoff_cause: 'iteration_limit',
      }),
    );
  });

  it("keeps a connector's own intent argument in the signature", async () => {
    // A user connector may give `intent` real meaning; only host-owned tools use it as wording.
    const toolSet = makeWorkspaceToolSet({ runFailure: 'nonzero', hostOwned: false });
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      if (round > 3) return finalAnswerStream();
      return toolCallStream({
        id: `lookup-${String(round)}`,
        name: 'lookup',
        args: { intent: ['open', 'close', 'renew'][round - 1], account: 'acme' },
      });
    });

    const events = await runThread(toolSet, create);

    expect(toolSet.callTool).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('counts sub-agent launches, so a parent cannot relaunch one child forever', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
    async function* spawnStream(
      toolName: string,
      round: number,
    ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
      yield* toolCallStream({
        id: `spawn-${String(round)}`,
        name: toolName,
        args: { name: 'researcher', input: 'Find the latest Qwen model.' },
      });
      return {
        output: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `spawn-${String(round)}`,
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify({ name: 'researcher', input: 'Find the latest Qwen model.' }),
              },
            },
          ],
        },
        usage: getEmptyUsage(),
        finish_reason: 'tool_calls',
      };
    }
    let round = 0;
    const rootModel: ILLM = {
      create: jest.fn(body => {
        round += 1;
        const tool = (body.tools ?? []).find(
          candidate => 'function' in candidate && candidate.function.name.includes('create_sub_agent'),
        );
        if (tool === undefined || !('function' in tool)) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return round > 6 ? finalAnswerStream() : spawnStream(tool.function.name, round);
      }),
      createNonStream: jest.fn(),
    };
    const capabilities: AgentCapability[] = [
      dynamicSubAgents({ sandboxAvailable: false, tracing: NOOP_AGENT_TRACING }),
    ];
    const root = new AgentThread({
      threadId: 'main',
      title: 'Main',
      definition: { modelId: undefined, configuredModels: undefined, modelClient: rootModel },
      context: [{ role: 'user', content: 'Delegate this.' }],
      capabilities,
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const agentThreads = new Map<string, AgentThread>([['main', root]]);
    const createDynamicSubAgentThread: CreateDynamicSubAgentThread = input =>
      Promise.resolve(
        new AgentThread({
          threadId: input.threadId,
          title: input.request.name,
          definition: {
            modelId: undefined,
            configuredModels: undefined,
            modelClient: { create: jest.fn(() => finalAnswerStream()), createNonStream: jest.fn() },
          },
          parent: input.parent,
          agentInfo: input.request,
          toolCallMemo: undefined,
          isRequestContinuation: undefined,
          tracing: NOOP_AGENT_TRACING,
          logger: makeSilentLogger(),
        }),
      );
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads,
      createDynamicSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const events: AgentThreadExecutionEvent[] = [];
    for await (const event of orchestrator.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(events.filter(event => event.type === EventType.THREAD_CREATED)).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error: expect.stringContaining('four times in this request'),
      }),
    );
  });

  it('keeps a mixed batch in order when a client-side call in it is still open', async () => {
    // Regression for the mixed-batch bug: a client-side call from the same assistant message
    // parks the whole batch (AgentThread's user-input-required state), so the host `run` call
    // next to it has no result yet either when the client answers. Once the client's answer
    // unparks the batch, `run` executes and the nudge for its second occurrence rides along in
    // that same append — never a user-role nudge landing ahead of a tool result that arrives
    // afterward.
    const toolSet = makeSucceedingRunToolSet();
    const runArgs = { command: 'cd /opt/tf/workspace && python3 qwen_search.py' };
    const nudgeText = 'You already made this exact run call in this request';
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round === 1) {
        return toolCallStream({ id: 'run-1', name: 'run', args: runArgs });
      }
      if (round === 2) {
        const questionTool = request.tools?.find(
          tool => tool.type === 'function' && tool.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME),
        );
        const questionToolName =
          questionTool?.type === 'function' ? questionTool.function.name : ASK_USER_QUESTION_TOOL_NAME;
        // The second `run` call (same signature as round 1, reaching the nudge point) sits in
        // the same assistant message as a still-open client-side call.
        return multiToolCallStream([
          { id: 'run-2', name: 'run', args: runArgs },
          { id: 'question-1', name: questionToolName, args: { question: 'Proceed?', options: ['Yes', 'No'] } },
        ]);
      }
      return finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const definition = {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition,
      context: [{ role: 'user', content: 'Find the latest Qwen model.' }],
      capabilities: [askUserQuestion()],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Consume until the thread pauses for the client-side answer.
    }

    // Not yet: the batch parks as a whole while question-1 is open, so `run`'s second call has
    // not executed either, and the nudge cannot exist yet.
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain(nudgeText);

    for await (const _event of thread.send([
      {
        type: 'user.tool_response',
        thread_id: 'main',
        tool_call_id: 'question-1',
        content: 'Yes, proceed.',
      },
    ])) {
      // Consume: this appends only question-1's own result — `run`'s second call still has not
      // executed, so the nudge must still not be present.
    }
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain(nudgeText);

    // Same request, same durable memo (see callSignatureCountsThisTurn's hydration comment): a
    // fresh AgentThread instance per continuation must still count `run`'s occurrences from
    // before the pause, or the second occurrence would look like the first again.
    const resumed = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: thread.toSnapshot().tool_call_memo,
      isRequestContinuation: true,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition,
      context: thread.toSnapshot().context,
      capabilities: [askUserQuestion()],
    });
    for await (const _event of resumed.execute({ signal: new AbortController().signal })) {
      // Consume the resumed execution to the end.
    }

    expect(requests).toHaveLength(3);
    const finalMessages = requests[2]?.messages ?? [];
    const assistantBatchIndex = finalMessages.findIndex(
      message => message.role === 'assistant' && 'tool_calls' in message && message.tool_calls?.length === 2,
    );
    expect(assistantBatchIndex).toBeGreaterThanOrEqual(0);
    const messagesAfterBatch = finalMessages.slice(assistantBatchIndex + 1);
    // Both tool results, then the nudge — never a user message ahead of a tool result from the
    // same batch, and the request message sequence stays assistant, tool, tool, user.
    expect(messagesAfterBatch[0]).toMatchObject({ role: 'tool' });
    expect(messagesAfterBatch[1]).toMatchObject({ role: 'tool' });
    expect(messagesAfterBatch[2]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(messagesAfterBatch[2])).toContain(nudgeText);
  });

  it('defers the nudge until a sub-agent launched from the same batch finishes', async () => {
    // A sub-agent launch is the concrete case that reaches the deferred-nudge path: unlike a
    // client-side or approval-required call, it does not park the whole batch (deriveAgentThreadState
    // only checks is_client_side / is_approval_required), so `run`'s second call executes in the
    // same step as the launch, while the launch's own tool result is not known until the sub-agent
    // later finishes. Appending the nudge right after `run`'s result at that point would put it
    // ahead of the sub-agent's result once AgentThreadOrchestrator delivers it, producing an
    // assistant -> tool -> user -> tool sequence.
    const toolSet = makeSucceedingRunToolSet();
    const runArgs = { command: 'cd /opt/tf/workspace && python3 qwen_search.py' };
    const nudgeText = 'You already made this exact run call in this request';
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const rootModel: ILLM = {
      create: jest.fn((request: LLMCreateParamsStreaming) => {
        requests.push(request);
        round += 1;
        if (round === 1) {
          return toolCallStream({ id: 'run-1', name: 'run', args: runArgs });
        }
        if (round === 2) {
          const spawnTool = request.tools?.find(
            tool => tool.type === 'function' && tool.function.name.includes('create_sub_agent'),
          );
          if (spawnTool === undefined || !('function' in spawnTool)) {
            throw new Error('dynamic sub-agent tool was not exposed');
          }
          // `run`'s second call (reaching the nudge point) sits in the same assistant message as
          // a sub-agent launch that is still running when this step's results are appended.
          return multiToolCallStream([
            { id: 'run-2', name: 'run', args: runArgs },
            {
              id: 'spawn-1',
              name: spawnTool.function.name,
              args: { name: 'researcher', input: 'Find the latest Qwen model.' },
            },
          ]);
        }
        return finalAnswerStream();
      }),
      createNonStream: jest.fn(),
    };
    const capabilities: AgentCapability[] = [
      dynamicSubAgents({ sandboxAvailable: false, tracing: NOOP_AGENT_TRACING }),
    ];
    const root = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient: rootModel,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Find the latest Qwen model.' }],
      capabilities,
    });
    const agentThreads = new Map<string, AgentThread>([['main', root]]);
    const createDynamicSubAgentThread: CreateDynamicSubAgentThread = input =>
      Promise.resolve(
        new AgentThread({
          threadId: input.threadId,
          title: input.request.name,
          definition: {
            modelId: undefined,
            configuredModels: undefined,
            modelClient: { create: jest.fn(() => finalAnswerStream()), createNonStream: jest.fn() },
          },
          parent: input.parent,
          agentInfo: input.request,
          toolCallMemo: undefined,
          isRequestContinuation: undefined,
          tracing: NOOP_AGENT_TRACING,
          logger: makeSilentLogger(),
        }),
      );
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads,
      createDynamicSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    for await (const _event of orchestrator.execute({ signal: new AbortController().signal })) {
      // Consume to completion.
    }

    // `run`'s own result (from round 2's step) precedes the sub-agent's result (delivered once it
    // finishes), which in turn precedes the nudge — never a user message ahead of a tool result
    // that arrives afterward.
    const context = root.toSnapshot().context;
    const runResultIndex = context.findIndex(
      message => 'role' in message && message.role === 'tool' && message.tool_call_id === 'run-2',
    );
    const spawnResultIndex = context.findIndex(
      message => 'role' in message && message.role === 'tool' && message.tool_call_id === 'spawn-1',
    );
    const nudgeIndex = context.findIndex(
      message =>
        'role' in message &&
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes(nudgeText),
    );
    expect(runResultIndex).toBeGreaterThanOrEqual(0);
    expect(spawnResultIndex).toBeGreaterThan(runResultIndex);
    expect(nudgeIndex).toBeGreaterThan(spawnResultIndex);
  });

  it('re-sends the nudge after compaction removes it, and still stops at the fourth call', async () => {
    // Regression for the compaction bug: callSignatureCountsThisTurn === 2 used to double as
    // both trigger and permanent "already sent" latch, but the nudge itself is an ordinary
    // context message that compaction (which explicitly skips internal system messages) can
    // drop. Once dropped, the third call ran with no warning and the model had no notice before
    // the fourth call stopped the turn. The fix re-derives "already sent" from context each
    // time, so a nudge compaction erased is sent again rather than staying silently lost.
    const toolSet = makeSucceedingRunToolSet();
    const runArgs = { command: 'cd /opt/tf/workspace && python3 qwen_search.py' };
    const nudgeText = 'You already made this exact run call in this request';
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return toolCallStream({ id: `run-${String(round)}`, name: 'run', args: runArgs });
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    // Compacts away on the preLLM pass before the third `run` call's request is built — right
    // after the second call's nudge landed in context, and before the third call can see it.
    const compaction = new CompactAwayOnNthCall(3);
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Find the latest Qwen model.' }],
      capabilities: [{ preLLMProcessors: [compaction] }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // Four provider calls: the turn does not stop early, and does not run a fifth time either —
    // the fourth occurrence of the same call stops it.
    expect(create).toHaveBeenCalledTimes(4);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error: expect.stringContaining('the same run call four times in this request'),
        handoff_cause: 'iteration_limit',
      }),
    );

    // Compaction wiped the nudge (and everything else) before the third call's request was
    // built, so that request must not carry it.
    expect(JSON.stringify(requests[2]?.messages)).not.toContain(nudgeText);
    // The third occurrence still gets a nudge in the request that follows it: the durable guard
    // found no nudge for `run` left in context (compaction erased it), so it is re-sent rather
    // than staying suppressed by a one-shot latch on the count.
    expect(JSON.stringify(requests[3]?.messages)).toContain(nudgeText);
  });

  it('does not stop a streak of grep with no matches (exit 1 treated as ok)', async () => {
    // Create a tool that simulates grep or similar search command: exit 1 means
    // no matches found and should not be treated as a failure.
    const toolSet = makeMockIMCPServer({
      name: 'search',
      preload: true,
      tools: [{ name: 'grep', description: 'Search for patterns', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    // Simulate grep finding no matches (exit 1), which should be treated as ok, not a failure
    jest.mocked(toolSet.callTool).mockImplementation(() =>
      Promise.resolve(
        toolResultResponse({
          text: JSON.stringify({
            status: 'ok',
            exit_code: 1,
            error_summary: null,
            success: true,
          }),
          isError: false, // exit 1 for grep is not an error
        }),
      ),
    );

    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      // Make 6 grep calls (no matches), then answer
      if (round > 6) return finalAnswerStream();
      return toolCallStream({
        id: `grep-${String(round)}`,
        name: 'grep',
        args: { pattern: `pattern_${String(round)}`, file: 'test.txt' },
      });
    });

    const events = await runThread(toolSet, create);

    // Should complete successfully, not stop due to failed batches
    // (grep with no matches is not a failure)
    expect(toolSet.callTool).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('does not stop a streak of exec results reported as "exited" (a pipeline or wrapped command)', async () => {
    // A pipeline or wrapped command that exits non-zero is never guessed at as ok or failed - it
    // is reported honestly as "exited" with isError: false, and must not count toward the
    // failed-batch guard any more than a genuine "ok" result does.
    const toolSet = makeMockIMCPServer({
      name: 'search',
      preload: true,
      tools: [{ name: 'exec', description: 'Run a shell command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(() =>
      Promise.resolve(
        toolResultResponse({
          text: JSON.stringify({
            status: 'exited',
            exit_code: 1,
            error_summary: null,
            success: true,
            note: "The command was a pipeline or wrapped command; the exit code is the last command's and earlier failures may be hidden. Read the output to judge.",
          }),
          isError: false, // "exited" never sets isError
        }),
      ),
    );

    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      // Five consecutive "exited" batches, then answer.
      if (round > 5) return finalAnswerStream();
      return toolCallStream({
        id: `exec-${String(round)}`,
        name: 'exec',
        args: { command: `cat file_${String(round)}.txt | grep pattern` },
      });
    });

    const events = await runThread(toolSet, create);

    // Should complete successfully: "exited" batches never count toward the failed-batch guard.
    expect(toolSet.callTool).toHaveBeenCalledTimes(5);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('stops after five consecutive exec results reported as "failed" (a host failure, not a command that ran)', async () => {
    // "failed" is reserved for the host's own failures - the command could not be started, was
    // killed by the execution timeout, or was refused by policy - never for a command that ran
    // and exited non-zero (that is always "ok" or "exited"). Modeled here as a repeated
    // execution-timeout kill, matching what buildExecResultShape reports when sandboxSuccess is
    // false.
    const toolSet = makeMockIMCPServer({
      name: 'search',
      preload: true,
      tools: [{ name: 'exec', description: 'Run a shell command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(() =>
      Promise.resolve(
        toolResultResponse({
          text: JSON.stringify({
            status: 'failed',
            exit_code: -1,
            error_summary: 'Command timed out after 60s and was killed',
            success: false,
            note: null,
          }),
          isError: true, // a genuine "failed" result does set isError
        }),
      ),
    );

    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      if (round > 6) return finalAnswerStream();
      return toolCallStream({
        id: `exec-${String(round)}`,
        name: 'exec',
        args: { command: `long-running-job_${String(round)}` },
      });
    });

    const events = await runThread(toolSet, create);

    // Stops at the fifth consecutive failed batch, never reaching a sixth call.
    expect(toolSet.callTool).toHaveBeenCalledTimes(5);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'error' });
  });

  it('does not stop five different "exited" commands, but does stop the fourth identical "exited" call', async () => {
    // Neither guard sees an "exited" result as a failure (isError is false), so five different
    // exited commands run to completion untouched by the failure budget. But the identical-call
    // guard is keyed on the call signature, not on the result: the model repeating the exact same
    // command four times still trips it, whatever status that command reports.
    const toolSet = makeMockIMCPServer({
      name: 'search',
      preload: true,
      tools: [{ name: 'exec', description: 'Run a shell command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(() =>
      Promise.resolve(
        toolResultResponse({
          text: JSON.stringify({
            status: 'exited',
            exit_code: 1,
            error_summary: null,
            success: true,
            note: EXITED_NOTE,
          }),
          isError: false, // "exited" never sets isError
        }),
      ),
    );

    // First, five different exited commands: must run to completion, not stop early.
    let round = 0;
    const differentCommandsCreate = jest.fn(() => {
      round += 1;
      if (round > 5) return finalAnswerStream();
      return toolCallStream({
        id: `exec-${String(round)}`,
        name: 'exec',
        args: { command: `cat file_${String(round)}.txt | grep pattern` },
      });
    });
    const differentEvents = await runThread(toolSet, differentCommandsCreate);
    expect(toolSet.callTool).toHaveBeenCalledTimes(5);
    expect(differentEvents.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });

    // Then, the same exited command called four times in a row: the identical-call guard stops
    // the turn on the fourth occurrence, never reaching a fifth call, even though every one of
    // those results is "exited" and never sets isError.
    jest.mocked(toolSet.callTool).mockClear();
    let identicalRound = 0;
    const identicalCommandCreate = jest.fn(() => {
      identicalRound += 1;
      if (identicalRound > 5) return finalAnswerStream();
      return toolCallStream({
        id: `exec-identical-${String(identicalRound)}`,
        name: 'exec',
        args: { command: 'cat file.txt | grep pattern' },
      });
    });
    const identicalEvents = await runThread(toolSet, identicalCommandCreate);

    expect(toolSet.callTool).toHaveBeenCalledTimes(4);
    expect(identicalEvents).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error: expect.stringContaining('the same exec call four times in this request'),
        handoff_cause: 'iteration_limit',
      }),
    );
  });
});

describe('pre-edit discovery hard cap', () => {
  /** A toolset with a read-only `search` tool and a structured `edit_file` tool, both always
   * succeeding with distinct, non-empty results, so only the pre-edit inspection count under
   * test drives the turn's outcome - none of the other budgets (empty-inspection, no-progress,
   * failed-batch, identical-call) are anywhere near their own thresholds. */
  function makeDiscoveryToolSet(): IToolSet {
    const toolSet = makeMockIMCPServer({
      name: 'discovery',
      preload: true,
      tools: [
        { name: 'search', description: 'Search the repo', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
        { name: 'edit_file', description: 'Apply a structured edit', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      ],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'truefoundry-system',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
        effect: params.name === 'search' ? 'inspect' : 'edit',
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(params =>
      Promise.resolve(
        toolResultResponse({
          text: params.name === 'search' ? `result for ${JSON.stringify(params.arguments)}` : 'edited',
        }),
      ),
    );
    return toolSet;
  }

  /** Same as {@link runThreadInstance} but with a raised `iterationLimit`: the default of 25 is
   * below the 30-call inspection cap under test here, so these tests would otherwise hit that
   * unrelated ceiling first. */
  async function runThreadWithRoom(toolSet: IToolSet, create: jest.Mock): Promise<unknown[]> {
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
        iterationLimit: 60,
      },
      context: [{ role: 'user', content: 'find and fix the bug' }],
    });
    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }
    return events;
  }

  it('stops the turn after 30 pre-edit inspection calls with no edit made', async () => {
    const toolSet = makeDiscoveryToolSet();
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      if (round > 30) return finalAnswerStream();
      return toolCallStream({
        id: `search-${String(round)}`,
        name: 'search',
        args: { query: `symbol_${String(round)}` },
      });
    });

    const events = await runThreadWithRoom(toolSet, create);

    // The 30th call trips the cap before the model is asked for a 31st.
    expect(create).toHaveBeenCalledTimes(30);
    expect(toolSet.callTool).toHaveBeenCalledTimes(30);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        error:
          'The model ran 30 inspection commands in this request without making an edit, so the request was stopped. Say which file or symbol to change, or ask it to summarise what it found so far.',
        handoff_cause: 'iteration_limit',
      }),
    );
  });

  it('resets the pre-edit inspection count once a structured edit succeeds, so later inspection does not trip the cap', async () => {
    const toolSet = makeDiscoveryToolSet();
    let round = 0;
    const create = jest.fn(() => {
      round += 1;
      // 25 inspections (under the cap on their own), one structured edit, then 25 more
      // inspections that would total 50 and trip the cap were the count not reset by the edit.
      if (round <= 25) {
        return toolCallStream({
          id: `search-${String(round)}`,
          name: 'search',
          args: { query: `symbol_${String(round)}` },
        });
      }
      if (round === 26) {
        return toolCallStream({ id: 'edit-1', name: 'edit_file', args: { path: 'a.ts', patch: 'diff' } });
      }
      if (round <= 51) {
        return toolCallStream({
          id: `search-post-edit-${String(round)}`,
          name: 'search',
          args: { query: `after_edit_${String(round)}` },
        });
      }
      return finalAnswerStream();
    });

    const events = await runThreadWithRoom(toolSet, create);

    expect(toolSet.callTool).toHaveBeenCalledTimes(51);
    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });
});
