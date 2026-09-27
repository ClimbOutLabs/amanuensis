import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

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
  context?: { role: 'user'; content: string }[] | undefined;
}): { thread: AgentThread; create: jest.Mock } {
  const create = jest.fn(promptStream);
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
    context: input.context ?? [{ role: 'user', content: 'A question.' }],
    // No capabilities: no pre-LLM processors, so forced compaction is a no-op and the
    // guard's fail-fast path is deterministic.
    capabilities: [],
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

describe('request assembly pre-flight guard', () => {
  it('fails fast before the synchronous transform on a giant context', async () => {
    const oversized = 'x'.repeat(4_000_001);
    const { thread, create } = makeThread({
      context: [{ role: 'user', content: oversized }],
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The request is never assembled and never sent: the guard fires before
    // transformToLLMRequest does its synchronous work.
    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('fatal_error');
    expect(done.error).toContain('safety ceiling');
    expect(done.error).toContain('refusing to assemble');
    expect(done.error).toContain('Start a new chat');
  });

  it('lets a normal context through to the model', async () => {
    const { thread, create } = makeThread({});
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });
});
