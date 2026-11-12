import type { ILLM, LLMCreateParams } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS } from '../../../src/core/llm/streamDeadline';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread, MODEL_STOPPED_ANSWERING_MESSAGE } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

type ModelStream = AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;

const CALL = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'tool_a', arguments: '{"title":"Checklist"}' },
};

function chunk(choice: ExtendedChatCompletionChunk['choices'][number]): ExtendedChatCompletionChunk {
  return { id: 'chunk', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [choice] };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A server that batches tool inputs: the call's name arrives at once, the arguments and the finish
 * only after a long quiet gap.
 */
async function* batchedToolCall({ gapMs }: { gapMs: number }): ModelStream {
  yield chunk({
    index: 0,
    delta: {
      role: 'assistant',
      tool_calls: [{ index: 0, id: CALL.id, type: 'function', function: { name: CALL.function.name, arguments: '' } }],
    },
    finish_reason: null,
  });
  await wait(gapMs);
  yield chunk({
    index: 0,
    delta: { tool_calls: [{ index: 0, function: { arguments: CALL.function.arguments } }] },
    finish_reason: null,
  });
  yield chunk({ index: 0, delta: {}, finish_reason: 'tool_calls' });
  return {
    output: { role: 'assistant', content: null, tool_calls: [CALL] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** Some text, then silence: no tool call was ever open. */
async function* textThenSilence(): ModelStream {
  yield chunk({ index: 0, delta: { role: 'assistant', content: 'Let me see' }, finish_reason: null });
  await new Promise<never>(() => undefined);
  return { output: { role: 'assistant', content: null }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

function makeThread(input: {
  create: (body: LLMCreateParams) => ModelStream;
  modelToolCallIdleTimeoutMs?: number | undefined;
}) {
  const create = jest.fn(input.create);
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const toolSet = makeMockIMCPServer({
    name: 'spaces',
    preload: true,
    tools: [{ name: 'tool_a', description: 'A', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: toolSet.id,
    mcp_server_name: toolSet.name,
    original_tool_name: 'tool_a',
    is_approval_required: false,
  });
  jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'ok' }));
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
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
    context: [{ role: 'user', content: 'Update my checklist space.' }],
    modelFirstResponseTimeoutMs: 90_000,
    modelIdleTimeoutMs: 60_000,
    modelToolCallIdleTimeoutMs: input.modelToolCallIdleTimeoutMs,
  });
  return { thread, create, toolSet };
}

async function drainEvents(thread: AgentThread): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function doneEvent(events: readonly AgentThreadEvent[]): InternalThreadDoneEvent | undefined {
  return events.find((event): event is InternalThreadDoneEvent => event.type === InternalEventType.AGENT_DONE);
}

describe('silence allowed while a tool call is open', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lets a call finish after ninety quiet seconds without retrying the step', async () => {
    let requests = 0;
    const { thread, create, toolSet } = makeThread({
      create: () => {
        requests += 1;
        return requests === 1 ? batchedToolCall({ gapMs: 90_000 }) : finalAnswerStream('Done.');
      },
    });
    const drained = drainEvents(thread);
    await jest.advanceTimersByTimeAsync(90_000);
    const events = await drained;

    // One request for the call and one for the answer after it: the quiet gap did not cost a retry.
    expect(create).toHaveBeenCalledTimes(2);
    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('still ends the step with the usual silence handling once the call stalls past its allowance', async () => {
    const { thread, create, toolSet } = makeThread({
      create: () => batchedToolCall({ gapMs: 10 * DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS }),
    });
    const drained = drainEvents(thread);
    // The first stall retries the step once; the second ends it. Each waits the tool-call allowance.
    await jest.advanceTimersByTimeAsync(DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS);
    expect(create).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS);
    const events = await drained;

    expect(toolSet.callTool).not.toHaveBeenCalled();
    const done = doneEvent(events);
    expect(done?.status).toBe('error');
    expect(done?.status === 'error' ? done.error : undefined).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
  });

  it('keeps the ordinary sixty seconds when no tool call is open', async () => {
    const { thread, create } = makeThread({ create: textThenSilence });
    const drained = drainEvents(thread);
    await jest.advanceTimersByTimeAsync(59_000);
    expect(create).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(create).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    const events = await drained;

    const done = doneEvent(events);
    expect(done?.status === 'error' ? done.error : undefined).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
  });

  it('uses the configured allowance, never one shorter than the ordinary bound', async () => {
    let requests = 0;
    const { thread, create } = makeThread({
      create: () => {
        requests += 1;
        return requests === 1 ? batchedToolCall({ gapMs: 50_000 }) : finalAnswerStream('Done.');
      },
      modelToolCallIdleTimeoutMs: 10_000,
    });
    const drained = drainEvents(thread);
    // The allowance is raised to the 60 s ordinary bound, so a 50 s gap is still fine.
    await jest.advanceTimersByTimeAsync(50_000);
    await drained;
    expect(create).toHaveBeenCalledTimes(2);
  });
});
