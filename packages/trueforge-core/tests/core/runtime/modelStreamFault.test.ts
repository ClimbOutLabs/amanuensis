import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { ModelOutputRepetitionError, ModelStreamFault } from '../../../src/core/llm/VercelAILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

/** A stream whose async iterable breaks before producing any content: the shape a provider
 * closing the connection mid-response takes (see VercelAILLM.mapStreamToChunks). */
async function* faultingStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  throw new ModelStreamFault('The model stream ended without any text, tool call, or finish signal.');
}

async function* finalStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
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

/**
 * Stand-in for ContextCompaction: records whether each preLLM pass was forced (see
 * AgentThreadExecutionContext.forceCompaction), and overwrites the context with a summary only
 * when it was: the same shape real compaction takes when its threshold check is bypassed.
 */
class RecordingCompaction implements PreLLMAgentContextProcessor {
  readonly forcedFlags: boolean[] = [];

  async *processPreLLM(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    await Promise.resolve();
    const forced = execution.forceCompaction === true;
    this.forcedFlags.push(forced);
    if (!forced) {
      return;
    }
    const summaryContext: ContextMessage[] = [{ role: 'assistant', content: 'Compacted summary of the turn so far.' }];
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

describe('ModelStreamFault retry', () => {
  it('compacts context and retries once after a single stream fault, then completes normally', async () => {
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      create.mock.calls.length === 1 ? faultingStream() : finalStream('Recovered answer.'),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const compaction = new RecordingCompaction();
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

    let doneEvent: InternalThreadDoneEvent | undefined;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvent = event;
      }
    }

    // One call faults, one call recovers: no third attempt.
    expect(create).toHaveBeenCalledTimes(2);
    // The ordinary preLLM pass before the first attempt is not forced; the pass triggered by the
    // fault, before the retry, is forced regardless of the configured compaction threshold.
    expect(compaction.forcedFlags).toEqual([false, true]);
    expect(doneEvent?.status).toBe('done');
  });

  it('ends the turn with reason model_stream_fault after a second stream fault in a row', async () => {
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      faultingStream(),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const compaction = new RecordingCompaction();
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

    let doneEvent: InternalThreadDoneEvent | undefined;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvent = event;
      }
    }

    // Exactly two attempts: the first fault triggers the one retry, and the retry's own fault
    // ends the turn instead of retrying again.
    expect(create).toHaveBeenCalledTimes(2);
    expect(compaction.forcedFlags).toEqual([false, true]);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.handoff_cause).toBe('model_stream_fault');
    if (doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    expect(doneEvent.error).toBe(
      "The model's output stream broke twice in a row, usually because the context is too long for it; start a new chat or use a different model",
    );
  });

  it('surfaces the repetition stop message instead of the generic stream-broke text', async () => {
    async function* repetitionFaultStream(): AsyncGenerator<
      ExtendedChatCompletionChunk,
      RawAssistantMessageWithUsage,
      unknown
    > {
      await Promise.resolve();
      throw new ModelOutputRepetitionError('reasoning');
    }
    const create = jest.fn(
      (): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
        repetitionFaultStream(),
    );
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
      capabilities: [],
    });

    let doneEvent: InternalThreadDoneEvent | undefined;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvent = event;
      }
    }

    expect(create).toHaveBeenCalledTimes(2);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.handoff_cause).toBe('model_stream_fault');
    if (doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    // The user gets the actionable guidance, not the misleading context-too-long text.
    expect(doneEvent.error).toBe(new ModelOutputRepetitionError('reasoning').message);
    expect(doneEvent.error).toMatch(/smaller parts/);
  });

  it('surfaces a definite provider error immediately without compaction or retry', async () => {
    // The provider error shape (a definite status, not a broken stream): must not trigger the
    // ModelStreamFault recovery path.
    async function* providerErrorStream(): AsyncGenerator<
      ExtendedChatCompletionChunk,
      RawAssistantMessageWithUsage,
      unknown
    > {
      await Promise.resolve();
      const cause = Object.assign(new Error('Internal Server Error'), {
        data: { message: '', type: 'InternalServerError', param: null, code: 500 },
      });
      throw new Error('Internal Server Error', { cause });
    }
    const create = jest.fn(
      (): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
        providerErrorStream(),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const compaction = new RecordingCompaction();
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

    let doneEvent: InternalThreadDoneEvent | undefined;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_DONE) {
        doneEvent = event;
      }
    }

    // Exactly one attempt: no retry for a definite provider error.
    expect(create).toHaveBeenCalledTimes(1);
    // No forced compaction: the only preLLM pass is the ordinary one before the attempt.
    expect(compaction.forcedFlags).toEqual([false]);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.handoff_cause).not.toBe('model_stream_fault');
    if (doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    expect(doneEvent.error).toBe('Internal Server Error');
    expect(doneEvent.error).not.toContain('context is too long');
  });
});
