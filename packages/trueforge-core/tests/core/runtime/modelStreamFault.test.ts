import type { TextStreamPart, ToolSet } from 'ai';
import type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  PreLLMAgentContextProcessor,
} from '../../../src/core/capabilities/AgentContextProcessor';
import { EventType, newEventId } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { mapStreamToChunks, ModelOutputRepetitionError, ModelStreamFault } from '../../../src/core/llm/VercelAILLM';
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

  constructor(private readonly summary: string = 'Compacted summary of the turn so far.') {}

  async *processPreLLM(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorOutput, void, unknown> {
    await Promise.resolve();
    const forced = execution.forceCompaction === true;
    this.forcedFlags.push(forced);
    if (!forced) {
      return;
    }
    const summaryContext: ContextMessage[] = [{ role: 'assistant', content: this.summary }];
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

/** Runs one turn on a short chat whose first model call streams `firstAttempt` and whose retry answers. */
async function runShortChatWithOneFault({
  firstAttempt,
  contextLength,
}: {
  firstAttempt: () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  contextLength: number | undefined;
}): Promise<{
  calls: number;
  forcedFlags: boolean[];
  compactionEvents: number;
  doneEvent: InternalThreadDoneEvent | undefined;
}> {
  const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
    create.mock.calls.length === 1 ? firstAttempt() : finalStream('Recovered answer.'),
  );
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const compaction = new RecordingCompaction();
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
      modelProperties: { contextLength },
    },
    context: [{ role: 'user', content: 'A question.' }],
    capabilities: [{ preLLMProcessors: [compaction] }],
  });

  let doneEvent: InternalThreadDoneEvent | undefined;
  let compactionEvents = 0;
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === InternalEventType.AGENT_DONE) {
      doneEvent = event;
    }
    if (event.type === EventType.AGENT_CONTEXT_OVERWRITE) {
      compactionEvents += 1;
    }
  }
  return { calls: create.mock.calls.length, forcedFlags: compaction.forcedFlags, compactionEvents, doneEvent };
}

/** A provider answering that the prompt does not fit, the way vLLM words it, through the real stream mapping. */
function contextLengthErrorStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  async function* parts(): AsyncGenerator<TextStreamPart<ToolSet>> {
    await Promise.resolve();
    const cause = Object.assign(
      new Error(
        "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens. Please reduce the length of the messages.",
      ),
      { data: { message: '', type: 'BadRequestError', param: null, code: 400 } },
    );
    yield { type: 'error', error: cause };
  }
  return mapStreamToChunks({ stream: parts(), chunkMeta: { id: 'test-id', created: 0, model: 'test-model' } });
}

/** Runs one turn where every model call streams `attempt`, and reports how it ended. */
async function runTurnWithFaults({
  attempt,
  compaction,
  contextLength,
}: {
  attempt: () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  compaction: RecordingCompaction;
  contextLength: number;
}): Promise<{ calls: number; doneEvent: InternalThreadDoneEvent | undefined }> {
  const create = jest.fn(attempt);
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
      modelProperties: { contextLength },
    },
    context: [{ role: 'user', content: 'A question.' }],
    capabilities: [{ preLLMProcessors: [compaction] }],
  });
  let doneEvent: InternalThreadDoneEvent | undefined;
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === InternalEventType.AGENT_DONE) {
      doneEvent = event;
    }
  }
  return { calls: create.mock.calls.length, doneEvent };
}

const CHAT_TOO_LONG_LINE = 'The chat is too long for this model. Start a new chat or use a different model.';

describe('ModelStreamFault retry', () => {
  it('checks the shortened history against the context length before the retry is sent', async () => {
    // The summary alone is far over an 8,000-token limit, so the shortened request cannot fit.
    const compaction = new RecordingCompaction('word '.repeat(20_000));
    const run = await runTurnWithFaults({ attempt: contextLengthErrorStream, compaction, contextLength: 8_000 });

    // The retry is never sent, and history is shortened only once.
    expect(run.calls).toBe(1);
    expect(compaction.forcedFlags).toEqual([false, true]);
    expect(run.doneEvent?.status).toBe('error');
    expect(run.doneEvent?.handoff_cause).toBe('model_stream_fault');
    if (run.doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    expect(run.doneEvent.error).toBe(CHAT_TOO_LONG_LINE);
  });

  it('shortens only once when the provider says the prompt is too long twice in a row', async () => {
    const compaction = new RecordingCompaction();
    const run = await runTurnWithFaults({ attempt: contextLengthErrorStream, compaction, contextLength: 128_000 });

    expect(run.calls).toBe(2);
    expect(compaction.forcedFlags).toEqual([false, true]);
    expect(run.doneEvent?.status).toBe('error');
    expect(run.doneEvent?.handoff_cause).toBe('model_stream_fault');
    if (run.doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    expect(run.doneEvent.error).toBe(CHAT_TOO_LONG_LINE);
  });

  it('retries a dropped stream on a short chat with the same history, without shortening it', async () => {
    const run = await runShortChatWithOneFault({ firstAttempt: faultingStream, contextLength: 128_000 });

    // One call faults, one call recovers: no third attempt.
    expect(run.calls).toBe(2);
    // Only the ordinary preLLM pass runs; the fault is not about context length, so nothing is shortened.
    expect(run.forcedFlags).toEqual([false]);
    expect(run.compactionEvents).toBe(0);
    expect(run.doneEvent?.status).toBe('done');
  });

  it('shortens history once and retries when the provider says the prompt is too long', async () => {
    const run = await runShortChatWithOneFault({ firstAttempt: contextLengthErrorStream, contextLength: 128_000 });

    expect(run.calls).toBe(2);
    expect(run.forcedFlags).toEqual([false, true]);
    expect(run.compactionEvents).toBe(1);
    expect(run.doneEvent?.status).toBe('done');
  });

  it('retries without shortening on a model whose context length is unknown', async () => {
    const run = await runShortChatWithOneFault({ firstAttempt: faultingStream, contextLength: undefined });

    expect(run.calls).toBe(2);
    expect(run.forcedFlags).toEqual([false]);
    expect(run.compactionEvents).toBe(0);
    expect(run.doneEvent?.status).toBe('done');
  });

  it('still shortens on a model whose context length is unknown when the fault names the context length', async () => {
    async function* contextFault(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
      await Promise.resolve();
      throw new ModelStreamFault('The stream broke.', {
        cause: new Error('prompt is too long: 210000 tokens > 200000 maximum'),
      });
    }
    const run = await runShortChatWithOneFault({ firstAttempt: contextFault, contextLength: undefined });

    expect(run.calls).toBe(2);
    expect(run.forcedFlags).toEqual([false, true]);
    expect(run.doneEvent?.status).toBe('done');
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
      turnToolCallLedger: undefined,
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
    expect(compaction.forcedFlags).toEqual([false]);
    expect(doneEvent?.status).toBe('error');
    expect(doneEvent?.handoff_cause).toBe('model_stream_fault');
    if (doneEvent?.status !== 'error') {
      throw new Error('expected an error-status AGENT_DONE event');
    }
    // A dropped stream is not blamed on the chat's length.
    expect(doneEvent.error).toBe(
      "The model's reply broke off twice in a row. Try again, or use a different model if it keeps happening.",
    );
  });

  it.each([
    ['the default name', undefined, 'Aman'],
    ['the name the person gave', 'Mannie', 'Mannie'],
  ])(
    'surfaces the repetition stop message with %s instead of the generic stream-broke text',
    async (_label, given, shown) => {
      async function* repetitionFaultStream(): AsyncGenerator<
        ExtendedChatCompletionChunk,
        RawAssistantMessageWithUsage,
        unknown
      > {
        await Promise.resolve();
        throw new ModelOutputRepetitionError();
      }
      const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
        repetitionFaultStream(),
      );
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
          identity: { assistantName: given },
        },
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
      expect(doneEvent.error).toBe(
        `${shown} was going in circles while thinking, so this reply stopped. Ask again in smaller parts.`,
      );
    },
  );

  it('surfaces a definite provider error immediately without compaction or retry', async () => {
    // The provider error shape (a definite status, not a broken stream): must not trigger the
    // ModelStreamFault recovery path. Goes through the real mapStreamToChunks classification so
    // the test fails if the classification regresses.
    async function* providerErrorParts(): AsyncGenerator<TextStreamPart<ToolSet>> {
      await Promise.resolve();
      const cause = Object.assign(new Error('Internal Server Error'), {
        data: { message: '', type: 'InternalServerError', param: null, code: 500 },
      });
      yield { type: 'error', error: cause };
    }
    const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> =>
      mapStreamToChunks({
        stream: providerErrorParts(),
        chunkMeta: { id: 'test-id', created: 0, model: 'test-model' },
      }),
    );
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const compaction = new RecordingCompaction();
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
