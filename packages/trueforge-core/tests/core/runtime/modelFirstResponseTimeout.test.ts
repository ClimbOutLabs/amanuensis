import type { ILLM, LLMCreateParams } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { ModelRequestGate } from '../../../src/core/llm/ModelRequestGate';
import { MODEL_WAITING_EVENT_TYPE } from '../../../src/core/llm/modelWaitingEvent';
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

/** Four finished searches behind the next step: the shape of the turn that lost its searches to a silence. */
const SEARCH_RESULTS = [
  'Labradors are friendly and eager.',
  'Poodles are clever and hypoallergenic.',
  'Corgis are short and bold.',
  'Greyhounds are gentle and fast.',
] as const;

const AFTER_FOUR_SEARCHES: ConstructorParameters<typeof AgentThread>[0]['context'] = [
  { role: 'user', content: 'Make me a page about dog breeds.' },
  ...SEARCH_RESULTS.flatMap((result, index) => {
    const id = `call_search_${String(index + 1)}`;
    return [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id,
            type: 'function' as const,
            function: { name: 'web_search', arguments: '{"query":"dog breeds"}' },
            tool_info: {
              type: 'mcp' as const,
              mcp_server_id: 'search',
              mcp_server_name: 'search',
              original_tool_name: 'web_search',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
      },
      { role: 'tool' as const, tool_call_id: id, content: result },
    ];
  }),
];

function makeThread(input: {
  create: (body: LLMCreateParams) => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  modelFirstResponseTimeoutMs?: number | undefined;
  modelIdleTimeoutMs?: number | undefined;
  context?: ConstructorParameters<typeof AgentThread>[0]['context'] | undefined;
  modelRequestGate?: { gate: ModelRequestGate; key: string; limit: number } | undefined;
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
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      modelRequestGate: input.modelRequestGate,
    },
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

  it('ends the step with a plain message when the provider stays silent through the one retry', async () => {
    const { thread, create } = makeThread({ create: hangingStream, modelFirstResponseTimeoutMs: 250 });
    const events = await drainEvents(thread, new AbortController().signal);

    // The step is sent twice: the first silence retries it, the second ends the turn.
    expect(create).toHaveBeenCalledTimes(2);
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('model_response_timeout');
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    // The error event is the turn's last event: nothing was emitted after it.
    expect(events[events.length - 1]).toBe(done);
  });

  it('ends the continuation after a tool result only once the retry also passes the first-token bound', async () => {
    jest.useFakeTimers();
    const { thread, create } = makeThread({
      create: hangingStream,
      modelFirstResponseTimeoutMs: 90_000,
      context: AFTER_TOOL_RESULT,
    });
    const drained = drainEvents(thread, new AbortController().signal);
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(89_000);
    expect(settled).toBe(false);
    // The first bound passes: the step is retried, so the turn is still live, not ended.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
    // The retry gets its own full bound; only its silence ends the turn.
    await jest.advanceTimersByTimeAsync(89_000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    const events = await drained;

    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    expect(done.handoff_cause).toBe('model_response_timeout');
  });

  it('ends a stream that goes silent mid-answer after the idle bound on both attempts, keeping what was written', async () => {
    jest.useFakeTimers();
    const { thread, create } = makeThread({
      create: stallsMidAnswer,
      modelFirstResponseTimeoutMs: 90_000,
      modelIdleTimeoutMs: 60_000,
      context: AFTER_TOOL_RESULT,
    });
    const drained = drainEvents(thread, new AbortController().signal);
    await jest.advanceTimersByTimeAsync(60_000);
    // The first mid-answer silence retried the step; its chunk is written again before it too stalls.
    expect(create).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    const events = await drained;

    const written = events.filter(event => event.type === 'model.message.delta');
    expect(written.length).toBeGreaterThan(0);
    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
  });

  it("ends the step with the same message when the model client's own deadline fires twice", async () => {
    const { thread, create } = makeThread({ create: clientDeadline, context: AFTER_TOOL_RESULT });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(2);
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

  it('retries a step that goes silent after four searches once, with their results kept, and finishes the job', async () => {
    let calls = 0;
    const { thread, create } = makeThread({
      create: () => {
        calls += 1;
        return calls === 1 ? hangingStream() : promptStream();
      },
      modelFirstResponseTimeoutMs: 250,
      context: AFTER_FOUR_SEARCHES,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(2);
    // The retry was sent the finished searches: all four results are in its request.
    const retryBody: unknown = create.mock.calls[1]?.[0];
    const retryText = JSON.stringify(retryBody);
    for (const result of SEARCH_RESULTS) {
      expect(retryText).toContain(result);
    }
    // The turn finished the job, and no error line was ever emitted on the way.
    const done = doneEvent(events);
    expect(done?.status).toBe('done');
    expect(events.filter(event => event.type === InternalEventType.AGENT_DONE)).toHaveLength(1);
    expect(
      events.filter(event => event.type === InternalEventType.AGENT_DONE && event.status === 'error'),
    ).toHaveLength(0);
  });

  it('keeps the four search results in the retry history when the retry also goes silent', async () => {
    const { thread, create } = makeThread({
      create: hangingStream,
      modelFirstResponseTimeoutMs: 250,
      context: AFTER_FOUR_SEARCHES,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(2);
    const retryBody: unknown = create.mock.calls[1]?.[0];
    const retryText = JSON.stringify(retryBody);
    for (const result of SEARCH_RESULTS) {
      expect(retryText).toContain(result);
    }
    const done = expectErrorDone(events);
    expect(done.error).toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    expect(events[events.length - 1]).toBe(done);
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

/** An answer that starts, then holds its request open until the test releases it. */
async function* slowAnswer(
  release: Promise<void>,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'working' }, finish_reason: null }],
  };
  await release;
  return {
    output: { role: 'assistant', content: 'working' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function untilCalled(mock: jest.Mock): Promise<void> {
  for (let waited = 0; waited < 200 && mock.mock.calls.length === 0; waited += 1) {
    await pause(10);
  }
  if (mock.mock.calls.length === 0) {
    throw new Error('The model call never started');
  }
}

describe('per-model request limit', () => {
  it('a second turn on the same model waits, shows the waiting line, and its silence clock has not started', async () => {
    const gate = new ModelRequestGate();
    const shared = { gate, key: 'synthetic/model', limit: 1 };
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = makeThread({
      create: () => slowAnswer(firstHeld),
      modelFirstResponseTimeoutMs: 5_000,
      modelIdleTimeoutMs: 5_000,
      modelRequestGate: shared,
    });
    const second = makeThread({
      create: promptStream,
      // A short bound: if this clock started while the turn waited in line, the turn would end
      // with the silence message long before the first turn finishes.
      modelFirstResponseTimeoutMs: 300,
      modelIdleTimeoutMs: 300,
      modelRequestGate: shared,
    });
    const firstEvents: AgentThreadEvent[] = [];
    const secondEvents: AgentThreadEvent[] = [];
    const firstDrain = (async () => {
      for await (const event of first.thread.execute({ signal: new AbortController().signal })) {
        firstEvents.push(event);
      }
    })();
    await untilCalled(first.create);
    const secondDrain = (async () => {
      for await (const event of second.thread.execute({ signal: new AbortController().signal })) {
        secondEvents.push(event);
      }
    })();
    // Longer than the second turn's whole silence bound, spent entirely in line.
    await pause(600);
    expect(second.create).not.toHaveBeenCalled();
    expect(doneEvent(secondEvents)).toBeUndefined();
    const waiting = secondEvents.find(event => event.type === InternalEventType.PASSTHROUGH);
    if (waiting?.type !== InternalEventType.PASSTHROUGH) {
      throw new Error('Expected the waiting line event while the second turn waited');
    }
    expect(waiting.event.type).toBe(MODEL_WAITING_EVENT_TYPE);

    releaseFirst();
    await firstDrain;
    await secondDrain;
    expect(second.create).toHaveBeenCalledTimes(1);
    expect(doneEvent(firstEvents)?.status).toBe('done');
    expect(doneEvent(secondEvents)?.status).toBe('done');
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
