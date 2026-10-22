import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread, DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS } from '../../../src/core/runtime/AgentThread';
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

function makeThread(input: {
  create: () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  modelFirstResponseTimeoutMs?: number | undefined;
  context?: { role: 'user'; content: string }[] | undefined;
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

describe('model first-response watchdog', () => {
  it('fails the turn visibly when the provider never produces a first chunk', async () => {
    const { thread, create } = makeThread({ create: hangingStream, modelFirstResponseTimeoutMs: 250 });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('model_response_timeout');
    // Clear, actionable, and free of any model content: there is none to leak, and the message
    // must not invent any.
    expect(done.error).toContain('no output within 1 second');
    expect(done.error).toContain('stopped instead of hanging');
    expect(done.error).not.toContain('reasoning');
  });

  it('lets a responsive model complete normally under the same watchdog', async () => {
    const { thread, create } = makeThread({ create: promptStream, modelFirstResponseTimeoutMs: 5000 });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('treats cancellation during the wait as an abort, not a timeout', async () => {
    const { thread } = makeThread({ create: hangingStream, modelFirstResponseTimeoutMs: 5000 });
    const controller = new AbortController();
    const drained = drainEvents(thread, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const events = await drained;

    // No terminal event at all: the aborted turn simply ends.
    expect(doneEvent(events)).toBeUndefined();
  });

  it('pins the default watchdog at ten minutes', () => {
    expect(DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS).toBe(600_000);
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
