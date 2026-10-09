import { StructuredEditPreconditionBlockedError, ToolPolicyBlockedError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/** Streamed assistant turn that calls one registered tool. */
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

const POLICY_NOTE_TEXT = "were blocked by this conversation's tool policy";
const NO_PROGRESS_NOTE_TEXT = 'consecutive tool calls were blocked before they ran';
const FAILED_BATCH_NOTE_TEXT = 'consecutive tool batches have failed';

/**
 * A tool set with configurable policy-blocked tools plus one working tool and one tool
 * whose `toolCallInfo` fails ordinarily (generic error, not a policy rejection). The
 * blocked tools' `toolCallInfo` rejects with `ToolPolicyBlockedError`, which the runtime
 * classifies as a pre-dispatch `policy_blocked` failure; the broken tool's generic failure
 * becomes disposition `never_ran`, which must not consume the policy budget.
 */
function makePolicyBlockedToolSet(blockedNames: string[] = ['write_file']) {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [
      { name: 'write_file', description: 'Write', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'read_file', description: 'Read', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'broken_tool', description: 'Broken', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params => {
    if (blockedNames.includes(params.name)) {
      return Promise.reject(new ToolPolicyBlockedError(`Tool '${params.name}' is not allowed on MCP server workspace`));
    }
    if (params.name === 'broken_tool') {
      return Promise.reject(new Error('tool info unavailable'));
    }
    return Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    });
  });
  jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
  return toolSet;
}

function makeThread(modelClient: ILLM, toolSet: ReturnType<typeof makePolicyBlockedToolSet>) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
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
    context: [{ role: 'user', content: 'do the thing' }],
  });
}

async function drainExecute(thread: AgentThread): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

describe('policy-block guard', () => {
  it('stops after three policy-blocked calls in a turn even when successful calls intervene', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const writeStream = (id: string, attempt: number) => toolCallStream({ id, name: 'write_file', args: { attempt } });
    const readStream = (id: string) => toolCallStream({ id, name: 'read_file', args: { id } });

    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Blocked, success, blocked, success, blocked: the consecutive-batch streaks reset on
      // every success, but the per-turn policy budget must not.
      if (round === 1) return writeStream('call-1', 1);
      if (round === 2) return readStream('call-2');
      if (round === 3) return writeStream('call-3', 2);
      if (round === 4) return readStream('call-4');
      if (round === 5) return writeStream('call-5', 3);
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    // Rounds 3 and 4 prove the turn survived the second block (no premature stop); the
    // absence of a round 7 proves the third block stopped it. Loop recovery turns the
    // stop into a final-answer pass, so the turn still ends done.
    expect(create).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    // The nudge from the second block is visible in the fourth round's request.
    expect(JSON.stringify(requests[3]?.messages)).toContain(`2 tool calls ${POLICY_NOTE_TEXT}`);
    // The stop's recovery note names the limitation in the final-answer request.
    expect(JSON.stringify(requests[5]?.messages)).toContain('not allowed here');
  });

  it('nudges once at the second policy-blocked call and does not stop there', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round <= 2) return toolCallStream({ id: `call-${String(round)}`, name: 'write_file', args: { round } });
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(POLICY_NOTE_TEXT);
    expect(JSON.stringify(requests[2]?.messages)).toContain(`2 tool calls ${POLICY_NOTE_TEXT}`);
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(POLICY_NOTE_TEXT)).toHaveLength(2); // sent exactly once
  });

  it('suppresses the generic no-progress and failed-batch notes when the policy guard owns the batch', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three consecutive policy-blocked batches: the policy guard nudges at two and stops
      // at three, so the generic streak notes must stay silent.
      if (round <= 3) return toolCallStream({ id: `call-${String(round)}`, name: 'write_file', args: { round } });
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    expect(create).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages).toContain(POLICY_NOTE_TEXT);
    expect(finalMessages).not.toContain(NO_PROGRESS_NOTE_TEXT);
    expect(finalMessages).not.toContain(FAILED_BATCH_NOTE_TEXT);
  });

  it('resets the per-turn budget when a new user message starts a request', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Two blocks per turn: each turn nudges but never stops.
      if (round === 1 || round === 2 || round === 4 || round === 5) {
        return toolCallStream({ id: `call-${String(round)}`, name: 'write_file', args: { round } });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);
    const signal = new AbortController().signal;

    const events = await drainExecute(thread);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });

    for await (const _e of thread.send([{ type: EventType.USER_MESSAGE, content: 'try again' }], signal)) {
      // draining the append is enough
    }
    const events2 = await drainExecute(thread);
    expect(events2.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });

    // Turn 1: rounds 1-3, turn 2: rounds 4-6. If the budget had leaked across the user
    // message, the fourth block would have stopped the second turn at five creates.
    expect(create).toHaveBeenCalledTimes(6);
    // Each request carries the full context, so the first turn's nudge is visible in every
    // later request: count per request instead. Turn 2's second-block request shows only
    // the first turn's nudge; the final request shows both turns' nudges, proving the
    // second turn re-nudged instead of being suppressed by the lingering marker.
    const turn2SecondBlockMessages = JSON.stringify(requests[4]?.messages);
    expect(turn2SecondBlockMessages.split(POLICY_NOTE_TEXT)).toHaveLength(2);
    const turn2FinalMessages = JSON.stringify(requests[5]?.messages);
    expect(turn2FinalMessages.split(POLICY_NOTE_TEXT)).toHaveLength(3);
  });

  it('does not let ordinary pre-dispatch failures consume the policy budget', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three never_ran failures: the no-progress guard may nudge (its threshold is 3),
      // but the policy guard must stay silent and must not stop the turn.
      if (round <= 3) {
        return toolCallStream({ id: `call-${String(round)}`, name: 'broken_tool', args: { round } });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    expect(create).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages).not.toContain(POLICY_NOTE_TEXT);
  });

  it('counts policy-blocked calls across different tool names together', async () => {
    const toolSet = makePolicyBlockedToolSet(['write_file', 'read_file']);
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three different blocked tools: the budget counts calls, not tool names.
      if (round === 1) return toolCallStream({ id: 'call-1', name: 'write_file', args: { round } });
      if (round === 2) return toolCallStream({ id: 'call-2', name: 'read_file', args: { round } });
      if (round === 3) return toolCallStream({ id: 'call-3', name: 'broken_tool', args: { round } });
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    // write_file and read_file are blocked; broken_tool is never_ran, so the third
    // round must NOT stop the turn — only two policy blocks were counted.
    expect(create).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(`2 tool calls ${POLICY_NOTE_TEXT}`);
  });

  it('does not count structured-edit precondition failures against the policy budget', async () => {
    // No blocked names: write_file instead fails the post-approval structured-edit
    // precondition (target changed after approval), which the dispatch catch
    // classifies with the policy_blocked disposition but a structured_edit_stale
    // remediation. The tool is allowed and retrying after a fresh read is the correct
    // recovery, so it must not feed the policy budget or its "not allowed here"
    // diagnosis.
    const toolSet = makePolicyBlockedToolSet([]);
    jest
      .mocked(toolSet.callTool)
      .mockImplementation(() =>
        Promise.reject(
          new StructuredEditPreconditionBlockedError(
            'The structured-edit target changed after approval. No edit was dispatched. Read the target again and submit a fresh edit request.',
          ),
        ),
      );
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round <= 3) {
        return toolCallStream({ id: `call-${String(round)}`, name: 'write_file', args: { round } });
      }
      return finalAnswerStream();
    });
    const thread = makeThread({ create, createNonStream: jest.fn() }, toolSet);

    const events = await drainExecute(thread);

    // Three stale edits: the turn survives (no stop at three) and the policy guard
    // stays silent the whole way.
    expect(create).toHaveBeenCalledTimes(4);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(POLICY_NOTE_TEXT);
  });

  it('keeps the standing budget when an approval continuation rebuilds the thread', async () => {
    const toolSet = makePolicyBlockedToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Two blocks, then the turn ends (as if suspending for approval).
      if (round <= 2) {
        return toolCallStream({ id: `call-${String(round)}`, name: 'write_file', args: { round } });
      }
      return finalAnswerStream();
    });
    const firstThread = makeThread({ create, createNonStream: jest.fn() }, toolSet);
    const firstEvents = await drainExecute(firstThread);
    expect(firstEvents.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(`2 tool calls ${POLICY_NOTE_TEXT}`);

    // The host rebuilds the thread from the snapshot to continue the same turn after
    // the approval decision. The two standing blocks must carry over: one more
    // policy-blocked call reaches the stop threshold instead of restarting at 0.
    const snapshot = firstThread.toSnapshot();
    const continuedCreate = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round === 4) {
        return toolCallStream({ id: 'call-4', name: 'write_file', args: { round } });
      }
      return finalAnswerStream();
    });
    const continuedThread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: snapshot.tool_call_memo ?? undefined,
      taskState: snapshot.task_state ?? undefined,
      isRequestContinuation: true,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient: { create: continuedCreate, createNonStream: jest.fn() },
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'do the thing' }],
    });
    const continuedEvents = await drainExecute(continuedThread);

    // One round plus the recovery final answer: the third block stopped the turn.
    expect(continuedCreate).toHaveBeenCalledTimes(2);
    expect(continuedEvents.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('not allowed here');
  });
});
