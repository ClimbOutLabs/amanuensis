import type {
  AgentContextProcessorOutput,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type {
  CompletionUsage,
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadAppendContext, ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import { EMPTY_ANSWER_NUDGE_MESSAGE, isInternalSystemMessage } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* reasoningOnlyStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'reasoning-only-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking it over.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, reasoning_content: 'Thinking it over.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* reasoningOnlyStreamWithUsage(
  usage: CompletionUsage,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'reasoning-only-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking it over.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, reasoning_content: 'Thinking it over.' },
    usage,
    finish_reason: 'stop',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalStreamWithUsage(
  content: string,
  usage: CompletionUsage,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content },
    usage,
    finish_reason: 'stop',
  };
}

/**
 * A minimal `PreLLMAgentContextProcessor` standing in for `ContextCompaction`: on its second
 * invocation (the retry's own preLLM pass) it overwrites the entire context with a summary and
 * drops the exact nudge-tagged message the durable guard looks for, exactly as real compaction
 * would once the nudge pushes the turn over its token threshold.
 */
class CompactAwayNudgeOnSecondCall implements PreLLMAgentContextProcessor {
  private calls = 0;

  // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
  async *processPreLLM(): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    this.calls += 1;
    if (this.calls !== 2) {
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

describe('empty-answer nudge durability', () => {
  it('never durably appends or emits the empty reasoning-only turn on a root thread', async () => {
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      create.mock.calls.length === 1 ? reasoningOnlyStream() : finalStream('Real answer.'),
    );
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
    });

    const appends: AgentThreadAppendContext[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appends.push(event);
      }
    }

    expect(create).toHaveBeenCalledTimes(2);
    // The reasoning-only turn must never reach durable context or the output stream: the only
    // append before the retry's real answer is the nudge system message, with no output events.
    const nudgeAppend = appends.find(append =>
      append.context.some(
        message =>
          isInternalSystemMessage(message) &&
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.includes(EMPTY_ANSWER_NUDGE_MESSAGE),
      ),
    );
    expect(nudgeAppend).toBeDefined();
    expect(nudgeAppend?.output).toHaveLength(0);
    const emptyAssistantAppend = appends.find(append =>
      append.context.some(message => 'role' in message && message.role === 'assistant' && !message.content),
    );
    expect(emptyAssistantAppend).toBeUndefined();
    const emptyOutputEvent = appends.some(append =>
      append.output.some(output => 'content' in output && !output.content),
    );
    expect(emptyOutputEvent).toBe(false);
  });

  it('does not create a sub-agent done completion for the reasoning-only turn, so a restart reruns the model instead of replaying an empty result', async () => {
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      create.mock.calls.length === 1 ? reasoningOnlyStream() : finalStream('Delegated answer.'),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const parent = { thread_id: 'root', tool_call_id: 'call-1' };
    const thread = new AgentThread({
      threadId: 'child',
      title: 'Child',
      parent,
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'Delegated task.' }],
    });

    const appends: AgentThreadAppendContext[] = [];
    let doneEvents = 0;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appends.push(event);
      }
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvents += 1;
      }
    }

    // No append before the real answer may carry a "done" completion for the empty reasoning-only
    // response: that would be replayed to the parent verbatim if the thread restarted right after
    // that append and before the retry.
    const prematureCompletion = appends.find(
      append => append.completion !== undefined && append.completion.send_to_parent.content.length === 0,
    );
    expect(prematureCompletion).toBeUndefined();
    expect(doneEvents).toBe(1);

    // Simulate a restart: reconstruct a fresh thread from exactly what was durably appended before
    // the retry (i.e. with no pre-computed completion, since none should have been persisted), and
    // confirm it runs the model again rather than completing with empty content.
    const durableContextBeforeRetry = appends
      .slice(0, appends.findIndex(append => append.completion !== undefined) + 1 || appends.length)
      .flatMap(append => append.context);
    const restartCreate = jest.fn(() => finalStream('Delegated answer after restart.'));
    const restartModelClient: ILLM = { create: restartCreate, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const restarted = new AgentThread({
      threadId: 'child',
      title: 'Child',
      parent,
      preComputedCompletion: undefined,
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient: restartModelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [],
      },
      context: [{ role: 'user', content: 'Delegated task.' }, ...durableContextBeforeRetry],
    });

    let restartedContent: string | undefined;
    for await (const event of restarted.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_DONE && event.status === 'done') {
        restartedContent = event.send_to_parent?.content;
      }
    }

    expect(restartCreate).toHaveBeenCalledTimes(1);
    expect(restartedContent).toBe('Delegated answer after restart.');
  });

  it('does not re-send the nudge after a restart mid-turn: the once-per-turn guard is durable, not an in-memory flag', async () => {
    // The model is reasoning-only on every call, so the host nudges once, then (still empty on
    // the retry) applies the fixed host note rather than nudging again. Run to completion — no
    // early generator termination — then take only the context durably appended up to and
    // including the nudge, discarding the retry's outcome: that is the state a thread restarted
    // between the nudge append and the retry would reconstruct from.
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      reasoningOnlyStream(),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const initialContext = [{ role: 'user' as const, content: 'A question.' }];
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: initialContext,
    });

    const appendsBeforeRestart: AgentThreadAppendContext[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appendsBeforeRestart.push(event);
      }
    }
    expect(create).toHaveBeenCalledTimes(2);
    const nudgeIndex = appendsBeforeRestart.findIndex(append =>
      append.context.some(
        message =>
          isInternalSystemMessage(message) &&
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.includes(EMPTY_ANSWER_NUDGE_MESSAGE),
      ),
    );
    expect(nudgeIndex).toBeGreaterThanOrEqual(0);

    // Reconstruct a fresh thread (a new AgentThread instance, as a restart would) from exactly the
    // durably-persisted context: the original messages plus the nudge, nothing more.
    const durableContextAfterNudge = [
      ...initialContext,
      ...appendsBeforeRestart.slice(0, nudgeIndex + 1).flatMap(append => append.context),
    ];
    const restartCreate = jest.fn(
      (): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> => reasoningOnlyStream(),
    );
    const restartModelClient: ILLM = { create: restartCreate, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const restarted = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelClient: restartModelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [],
      },
      context: durableContextAfterNudge,
    });

    const appendsAfterRestart: AgentThreadAppendContext[] = [];
    for await (const event of restarted.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appendsAfterRestart.push(event);
      }
    }

    // The reconstructed thread must recognize the nudge already fired (from durable context, since
    // the in-memory flag on the discarded first instance never survived the restart) and must not
    // send a second one or make a second provider call for it: exactly one call, whose still-empty
    // answer gets the fixed host note instead of a repeated nudge.
    expect(restartCreate).toHaveBeenCalledTimes(1);
    const secondNudgeAppend = appendsAfterRestart.find(append =>
      append.context.some(
        message =>
          isInternalSystemMessage(message) &&
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.includes(EMPTY_ANSWER_NUDGE_MESSAGE),
      ),
    );
    expect(secondNudgeAppend).toBeUndefined();
    const assistantAppend = appendsAfterRestart.find(append =>
      append.context.some(message => 'role' in message && message.role === 'assistant'),
    );
    const assistantMessage = assistantAppend?.context.find(
      message => 'role' in message && message.role === 'assistant',
    );
    const assistantContent = assistantMessage && 'content' in assistantMessage ? assistantMessage.content : undefined;
    expect(typeof assistantContent).toBe('string');
    expect((assistantContent as string).length).toBeGreaterThan(0);
  });

  it('folds the discarded reasoning-only call usage into thread metrics exactly once', async () => {
    const firstUsage: CompletionUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
    const secondUsage: CompletionUsage = { input_tokens: 20, output_tokens: 8, total_tokens: 28 };
    const create = jest
      .fn()
      .mockImplementationOnce(() => reasoningOnlyStreamWithUsage(firstUsage))
      .mockImplementationOnce(() => finalStreamWithUsage('Real answer.', secondUsage));
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
    });

    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      void event;
    }

    expect(create).toHaveBeenCalledTimes(2);
    const metrics = thread.getAgentThreadMetrics();
    // Both calls are real provider spend; the discarded first response's usage must be counted
    // even though its content and context message are never persisted.
    expect(metrics.total_input_tokens).toBe(firstUsage.input_tokens + secondUsage.input_tokens);
    expect(metrics.total_output_tokens).toBe(firstUsage.output_tokens + secondUsage.output_tokens);
    expect(metrics.total_tokens).toBe(firstUsage.total_tokens + secondUsage.total_tokens);
  });

  it('honors the once-per-turn guard even when compaction removes the nudge tag before the retry runs', async () => {
    // Both calls are reasoning-only: the first triggers the nudge, and a compaction-like preLLM
    // processor overwrites the entire context (dropping the exact nudge-tagged message) before the
    // retry's own model call. The guard must be read from context as it stood before that
    // processor ran, so the retry still recognizes the nudge already fired this turn and applies
    // the fixed host note instead of nudging (and calling the provider) a third time.
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      reasoningOnlyStream(),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const compaction = new CompactAwayNudgeOnSecondCall();
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
      capabilities: [{ preLLMProcessors: [compaction] }],
    });

    const appends: AgentThreadAppendContext[] = [];
    let doneEvents = 0;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appends.push(event);
      }
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvents += 1;
      }
    }

    // Exactly two provider calls: the compaction wiping the nudge tag must not fool the guard into
    // treating the retry as a first attempt and nudging (and calling the provider) again.
    expect(create).toHaveBeenCalledTimes(2);
    expect(doneEvents).toBe(1);
    const nudgeAppends = appends.filter(append =>
      append.context.some(
        message =>
          isInternalSystemMessage(message) &&
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.includes(EMPTY_ANSWER_NUDGE_MESSAGE),
      ),
    );
    expect(nudgeAppends).toHaveLength(1);
  });
});
