import type {
  AgentContextProcessorOutput,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import {
  finalAnswerStream,
  makeMockIMCPServer,
  makeSilentLogger,
  OBJECT_INPUT_SCHEMA,
  unknownToolStream,
} from '../harnessMocks';

/** Streamed assistant turn that calls one real (registered) tool, for the reset test below. */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStreamFor({
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

/**
 * A minimal `PreLLMAgentContextProcessor` standing in for `ContextCompaction`: on a chosen
 * invocation it overwrites the entire context with a summary, dropping every internal system
 * message (including a guard nudge), exactly as real compaction does.
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

describe('no-progress guard', () => {
  it('stops after five consecutive batches that were blocked before dispatch, even across different variants', async () => {
    // Five distinct hallucinated tool names: each is a different "variant", so the
    // existing repeated-unavailable-tool-name guard (which keys on an exact name
    // repeat) never fires. Every call still resolves to disposition 'never_ran'.
    const create = jest
      .fn()
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_1', callId: 'call-1' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_2', callId: 'call-2' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_3', callId: 'call-3' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_4', callId: 'call-4' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_5', callId: 'call-5' }))
      .mockImplementation(() => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'do the thing' }],
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // With loop recovery, the fifth blocked batch triggers a final-answer pass
    // instead of an immediate error; the model answers, so the turn succeeds.
    expect(create).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('does not stop before five consecutive blocked-before-dispatch batches', async () => {
    const create = jest
      .fn()
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_1', callId: 'call-1' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: 'tool_variant_2', callId: 'call-2' }))
      .mockImplementation(() => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'do the thing' }],
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'internal.agent.done',
        status: 'error',
        error: expect.stringContaining('blocked before they ran'),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });
});

describe('no-progress nudge', () => {
  const variantStream = (index: number) =>
    unknownToolStream({ toolName: `tool_variant_${String(index)}`, callId: `call-${String(index)}` });
  const noteText = 'consecutive tool calls were blocked before they ran';

  it('nudges once at the third consecutive blocked batch, continues to the fourth without resending, then stops at the fifth', async () => {
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 5 ? variantStream(round) : finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'do the thing' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(JSON.stringify(requests[2]?.messages)).not.toContain(noteText);
    expect(JSON.stringify(requests[3]?.messages)).toContain(`3 ${noteText}`);
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(noteText)).toHaveLength(2); // one occurrence splits into two parts
    // With loop recovery, the fifth blocked batch triggers a final-answer pass
    // instead of an immediate error; the model answers, so the turn succeeds.
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
  });

  it('resets the nudge state when a call runs, so a later streak nudges again', async () => {
    const toolSet = makeMockIMCPServer({
      name: 'workspace',
      preload: true,
      tools: [{ name: 'run', description: 'Run', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      }),
    );
    jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: 'ok' })));
    const runStream = (id: string) => toolCallStreamFor({ id, name: 'run', args: { id } });

    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      // Three blocked calls (nudged at the third), one call that actually runs (resets the
      // streak and its nudge state), then three more blocked calls that must be nudged again.
      if (round <= 3) return variantStream(round);
      if (round === 4) return runStream('reset');
      if (round <= 7) return variantStream(round);
      return finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const thread = new AgentThread({
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

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    const finalMessages = JSON.stringify(requests.at(-1)?.messages);
    expect(finalMessages.split(noteText)).toHaveLength(3); // both streaks' notes survive
  });

  it('re-sends the nudge after compaction removes it, and still stops at the fifth blocked call', async () => {
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      return round <= 5 ? variantStream(round) : finalAnswerStream();
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    // Compacts away right after the third blocked call's nudge landed in context, and before
    // the fourth blocked call's request is built.
    const compaction = new CompactAwayOnNthCall(4);
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'do the thing' }],
      capabilities: [{ preLLMProcessors: [compaction] }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // With loop recovery, the fifth blocked batch triggers a final-answer pass
    // instead of an immediate error; the model answers, so the turn succeeds.
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    expect(JSON.stringify(requests[3]?.messages)).not.toContain(noteText);
    expect(JSON.stringify(requests[4]?.messages)).toContain(noteText);
  });
});
