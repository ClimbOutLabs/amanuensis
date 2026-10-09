import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import {
  AgentThread,
  DEFAULT_PRE_LLM_PROCESSORS_TIMEOUT_MS,
  NoProgressTimeoutError,
} from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import type { AgentContextProcessorOutput } from '../../../src/core/capabilities/AgentContextProcessor';
import type { PreLLMAgentContextProcessor } from '../../../src/core/capabilities/AgentContextProcessor';
import type { AgentCapability } from '../../../src/core/capabilities/AgentCapability';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

/**
 * A processor that never yields and never errors: the silent-processor shape that left
 * turns active for hours with zero model steps, because the pre-LLM phase had no watchdog.
 */
async function* hangingProcessorOutput(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
  await new Promise<never>(() => undefined);
}

const hangingProcessor: PreLLMAgentContextProcessor = {
  processPreLLM: () => hangingProcessorOutput(),
};

/** A processor that completes immediately without touching the context. */
async function* emptyProcessorOutput(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
  // Yields nothing; completes at once.
}

const emptyProcessor: PreLLMAgentContextProcessor = {
  processPreLLM: () => emptyProcessorOutput(),
};

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
  capabilities?: readonly AgentCapability[] | undefined;
  preLLMProcessorsTimeoutMs?: number | undefined;
}): { thread: AgentThread; create: jest.Mock } {
  const create = jest.fn(promptStream);
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
    context: [{ role: 'user', content: 'A question.' }],
    capabilities: input.capabilities,
    preLLMProcessorsTimeoutMs: input.preLLMProcessorsTimeoutMs,
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

describe('pre-LLM processors watchdog', () => {
  it('fails the turn visibly when a processor never yields', async () => {
    const { thread, create } = makeThread({
      capabilities: [{ preLLMProcessors: [hangingProcessor] }],
      preLLMProcessorsTimeoutMs: 250,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The model is never reached: the stall happens before stream creation.
    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.error).toContain('Pre-LLM context processors produced no output within 1 second');
    expect(done.error).toContain('stopped instead of hanging');
  });

  it('lets a responsive processor complete normally under the same watchdog', async () => {
    const { thread, create } = makeThread({
      capabilities: [{ preLLMProcessors: [emptyProcessor] }],
      preLLMProcessorsTimeoutMs: 5000,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('treats cancellation during the processor wait as an abort, not a timeout', async () => {
    const { thread } = makeThread({
      capabilities: [{ preLLMProcessors: [hangingProcessor] }],
      preLLMProcessorsTimeoutMs: 5000,
    });
    const controller = new AbortController();
    const drained = drainEvents(thread, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const events = await drained;

    // No terminal event at all: the aborted turn simply ends.
    expect(doneEvent(events)).toBeUndefined();
  });

  it('pins the default watchdog at five minutes', () => {
    expect(DEFAULT_PRE_LLM_PROCESSORS_TIMEOUT_MS).toBe(300_000);
  });

  it('exports a distinguishable timeout error', () => {
    const error = new NoProgressTimeoutError('stalled');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NoProgressTimeoutError');
  });
});
