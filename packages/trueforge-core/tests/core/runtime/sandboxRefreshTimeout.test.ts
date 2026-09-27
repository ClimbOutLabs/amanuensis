import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread, DEFAULT_SANDBOX_REFRESH_TIMEOUT_MS } from '../../../src/core/runtime/AgentThread';
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

const repositoryContext = { branch: 'main', head_sha: 'abc123' };

/** A sandbox whose repository refresh never settles. */
function hangingSandbox() {
  return {
    getBoundRepositoryContext: () => repositoryContext,
    refreshBoundRepositoryState: () => new Promise<never>(() => undefined),
  };
}

/** A sandbox whose repository refresh completes immediately. */
function responsiveSandbox() {
  return {
    getBoundRepositoryContext: () => repositoryContext,
    // eslint-disable-next-line @typescript-eslint/require-await
    refreshBoundRepositoryState: async () => undefined,
  };
}

function makeThread(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandbox?: any;
  sandboxRefreshTimeoutMs?: number | undefined;
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
    context: [{ role: 'user', content: 'A question.' }],
    sandbox: input.sandbox,
    sandboxRefreshTimeoutMs: input.sandboxRefreshTimeoutMs,
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

describe('sandbox refresh watchdog', () => {
  it('continues with cached state when the refresh times out', async () => {
    const { thread, create } = makeThread({
      sandbox: hangingSandbox(),
      sandboxRefreshTimeoutMs: 250,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The turn completes: the timed-out refresh is skipped, not fatal.
    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('uses the refreshed state when the refresh completes in time', async () => {
    const { thread, create } = makeThread({
      sandbox: responsiveSandbox(),
      sandboxRefreshTimeoutMs: 5000,
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });

  it('pins the default watchdog at thirty seconds', () => {
    expect(DEFAULT_SANDBOX_REFRESH_TIMEOUT_MS).toBe(30_000);
  });
});
