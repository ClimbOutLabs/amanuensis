import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import {
  AgentThread,
  DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
  DEFAULT_MODEL_IDLE_TIMEOUT_MS,
  MODEL_STOPPED_ANSWERING_MESSAGE,
} from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

/**
 * A stream that never produces anything and never errors: the silent-provider shape that left
 * turns active for hours with zero model steps.
 */
async function* hangingStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await new Promise<never>(() => undefined);
  // Unreachable; present only so the generator has the declared yield/return types.
  yield {
    id: 'never',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'never' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: 'never' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* promptStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'answer' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

/** Starts an answer, then never sends another chunk: a stream that went silent mid-answer. */
async function* stallsMidAnswer(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is what I' }, finish_reason: null }],
  };
  await new Promise<never>(() => undefined);
  return {
    output: { role: 'assistant', content: 'never' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

/** The model client's own stream deadline firing, in the shape VercelAILLM throws it. */
// eslint-disable-next-line require-yield -- throws before its first chunk, like an expired deadline
async function* clientDeadline(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  throw new DOMException('First chunk timeout of 90000ms exceeded', 'TimeoutError');
}

/** History that ends in a web search's result: the next model call is the continuation after a tool. */
const AFTER_TOOL_RESULT: ConstructorParameters<typeof AgentThread>[0]['context'] = [
  { role: 'user', content: 'What is on in town tonight?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"events"}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'search',
          mcp_server_name: 'search',
          original_tool_name: 'web_search',
          is_approval_required: false,
          is_client_side: false,
        },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'A concert at the harbour at 8pm.' },
];

function makeThread(input: {
  create: () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  modelFirstResponseTimeoutMs?: number | undefined;
  modelIdleTimeoutMs?: number | undefined;
  context?: ConstructorParameters<typeof AgentThread>[0]['context'] | undefined;
}): { thread: AgentThread; create: jest.Mock } {
  const create = jest.fn(input.create);
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
    context: input.context ?? [{ role: 'user', content: 'A question.' }],
    modelFirstResponseTimeoutMs: input.modelFirstResponseTimeoutMs,
    modelIdleTimeoutMs: input.modelIdleTimeoutMs,
  });
  return { thread, create };
}

async function drainEvents(thread: AgentThread, signal: AbortSignal): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal })) {
    events.push(event);
  }
  return events;
}

function doneEvent(events: readonly AgentThreadEvent[]): InternalThreadDoneEvent | undefined {
  return events.find((event): event is InternalThreadDoneEvent => event.type === InternalEventType.AGENT_DONE);
}

function expectErrorDone(events: readonly AgentThreadEvent[]): InternalThreadDoneEvent & { status: 'error' } {
  const done = doneEvent(events);
  if (done?.status !== 'error') {
    throw new Error(`Expected an error done event, got status ${String(done?.status)}`);
  }
  return done;
}

describe('model silence bounds', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ends the step with a plain message when the provider never produces a first chunk', async () => {
    const { thread, create } = makeThread({ create: hangingStream, modelFirstResponseTimeoutMs: 250 });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('model_response_timeout');
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
  });

  it('ends the continuation after a tool result once the first-token bound passes', async () => {
    jest.useFakeTimers();
    const { thread } = makeThread({
      create: hangingStream,
      modelFirstResponseTimeoutMs: 90_000,
      context: AFTER_TOOL_RESULT,
    });
    const drained = drainEvents(thread, new AbortController().signal);
    await jest.advanceTimersByTimeAsync(89_000);
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    const events = await drained;

    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    expect(done.handoff_cause).toBe('model_response_timeout');
  });

  it('ends a stream that goes silent mid-answer after the idle bound, keeping what was written', async () => {
    jest.useFakeTimers();
    const { thread } = makeThread({
      create: stallsMidAnswer,
      modelFirstResponseTimeoutMs: 90_000,
      modelIdleTimeoutMs: 60_000,
      context: AFTER_TOOL_RESULT,
    });
    const drained = drainEvents(thread, new AbortController().signal);
    await jest.advanceTimersByTimeAsync(60_000);
    const events = await drained;

    const written = events.filter(event => event.type === 'model.message.delta');
    expect(written.length).toBeGreaterThan(0);
    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
  });

  it("ends the step with the same message when the model client's own deadline fires", async () => {
    const { thread } = makeThread({ create: clientDeadline, context: AFTER_TOOL_RESULT });
    const events = await drainEvents(thread, new AbortController().signal);

    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    expect(done.handoff_cause).toBe('model_response_timeout');
  });

  it('lets a responsive model complete normally under the same bounds', async () => {
    const { thread, create } = makeThread({ create: promptStream, modelFirstResponseTimeoutMs: 5000 });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('stops at once on Cancel while waiting for the model after a tool result', async () => {
    jest.useFakeTimers();
    const { thread } = makeThread({ create: hangingStream, context: AFTER_TOOL_RESULT });
    const controller = new AbortController();
    const drained = drainEvents(thread, controller.signal);
    await jest.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    const events = await drained;

    // No terminal event at all: the aborted turn simply ends, and the turn records it as cancelled.
    expect(doneEvent(events)).toBeUndefined();
  });

  it('pins the defaults at ninety seconds to the first token and sixty seconds idle', () => {
    expect(DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_MODEL_IDLE_TIMEOUT_MS).toBe(60_000);
  });
});

describe('model request safety net', () => {
  it('refuses to construct a pathological request instead of sending it', async () => {
    const oversized = 'x'.repeat(4_000_001);
    const { thread, create } = makeThread({
      create: promptStream,
      context: [{ role: 'user', content: oversized }],
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The request is never created: measurement happens before modelClient.create.
    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('fatal_error');
    expect(done.error).toContain('safety ceiling');
  });
});
