import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type {
  AgentThreadEvent,
  ContextMessage,
  InternalThreadDoneEvent,
} from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import type { AgentCapability } from '../../../src/core/capabilities/AgentCapability';
import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ModelParams } from '../../../src/core/runtime/AgentDefinition';
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
  context?: ContextMessage[] | undefined;
  modelProperties?: { contextLength: number | undefined } | undefined;
  modelParams?: ModelParams | undefined;
  capabilities?: readonly AgentCapability[] | undefined;
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
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      modelProperties: input.modelProperties,
      modelParams: input.modelParams,
    },
    context: input.context ?? [{ role: 'user', content: 'A question.' }],
    // No capabilities by default: no pre-LLM processors, so forced compaction is a
    // no-op and the guard's fail-fast path is deterministic.
    capabilities: input.capabilities ?? [],
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

/**
 * Test capability that replaces the context with a tiny summary when the host
 * forces a compaction pass (execution.forceCompaction). Ignores the normal
 * pre-LLM pass.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* shrinkOnForcedCompaction(
  execution: Readonly<AgentThreadExecutionContext>,
): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
  if (execution.forceCompaction !== true) {
    return;
  }
  yield {
    type: EventType.AGENT_CONTEXT_OVERWRITE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    reason: 'compaction',
    context: [{ role: 'user', content: 'Short.' }],
    current_context_usage: { prompt_tokens: 10, completion_tokens: 0 },
    usage: getEmptyUsage(),
  };
}

const forcedShrinkCapability: AgentCapability = {
  preLLMProcessors: [{ processPreLLM: shrinkOnForcedCompaction }],
};

/**
 * Test capability that compacts once during the normal pre-LLM pass (context
 * shrinks but stays over the token limit) and records any forced pass the host
 * asks for afterwards. Lets the test assert no second compaction is forced.
 */
function makeNormalCompactionCapability(onForced: () => void): AgentCapability {
  // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
  async function* compactOnce(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    if (execution.forceCompaction === true) {
      onForced();
      return;
    }
    yield {
      type: EventType.AGENT_CONTEXT_OVERWRITE,
      id: newEventId(),
      created_at: new Date().toISOString(),
      reason: 'compaction',
      context: [{ role: 'user', content: 'x'.repeat(15_000) }],
      current_context_usage: { prompt_tokens: 3750, completion_tokens: 0 },
      usage: getEmptyUsage(),
    };
    yield {
      type: EventType.AGENT_CONTEXT_COMPACTION,
      id: newEventId(),
      created_at: new Date().toISOString(),
      mode: 'conversation',
      tokens_before: 5000,
      tokens_after: 3750,
      summary_chars: 0,
      outcome: 'applied',
    };
  }
  return { preLLMProcessors: [{ processPreLLM: compactOnce }] };
}

describe('token-based pre-flight guard', () => {
  // 20_000 chars of text estimates to ~5_000 tokens: over a 4_096-token limit
  // with the 512-token margin, but far under the 4M-character ceiling, so only
  // the token guard fires.
  const OVER_LIMIT_CONTEXT: ContextMessage[] = [{ role: 'user', content: 'x'.repeat(20_000) }];

  it('forces a compaction pass when the estimated request exceeds the model context length', async () => {
    const { thread, create } = makeThread({
      context: OVER_LIMIT_CONTEXT,
      modelProperties: { contextLength: 4096 },
      capabilities: [forcedShrinkCapability],
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The forced compaction shrank the context under the limit, so the request
    // was assembled and sent.
    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
    expect(events.some(event => event.type === EventType.AGENT_CONTEXT_OVERWRITE)).toBe(true);
  });

  it('fails fast with a clear error when the request is still over the limit after compaction', async () => {
    const { thread, create } = makeThread({
      context: OVER_LIMIT_CONTEXT,
      modelProperties: { contextLength: 4096 },
      // No capabilities: forced compaction is a no-op, so the estimate stays over.
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('fatal_error');
    expect(done.error).toContain('context limit');
    expect(done.error).toContain('even after compaction');
    expect(done.error).toContain('Start a new chat');
  });

  it('sends the request untouched when the estimate is under the limit', async () => {
    const { thread, create } = makeThread({
      modelProperties: { contextLength: 128_000 },
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
    expect(events.some(event => event.type === EventType.AGENT_CONTEXT_COMPACTION)).toBe(false);
    expect(events.some(event => event.type === EventType.AGENT_CONTEXT_OVERWRITE)).toBe(false);
  });

  it('does not force a second compaction pass when normal pre-LLM processing already compacted', async () => {
    let forcedPasses = 0;
    const { thread, create } = makeThread({
      context: OVER_LIMIT_CONTEXT,
      modelProperties: { contextLength: 4096 },
      capabilities: [makeNormalCompactionCapability(() => {
        forcedPasses += 1;
      })],
    });
    const events = await drainEvents(thread, new AbortController().signal);

    // The normal pass compacted (15_000 chars ~= 3_750 tokens, still over the
    // 4_096 - 512 budget), so the guard skips its forced pass and fails clearly
    // instead of re-summarizing the fresh summary.
    expect(forcedPasses).toBe(0);
    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.error).toContain('even after compaction');
  });

  it('ignores image base64 payloads when estimating request tokens', async () => {
    // 2MB of base64 image data would read as ~500k tokens under the old
    // JSON.stringify estimate and force a bogus compaction; text-only
    // estimation counts just the caption.
    const imageMessage: ContextMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${'A'.repeat(2_000_000)}` },
        },
      ],
    };
    const { thread, create } = makeThread({
      context: [imageMessage],
      modelProperties: { contextLength: 128_000 },
    });
    const events = await drainEvents(thread, new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    expect(doneEvent(events)?.status).toBe('done');
  });
});
