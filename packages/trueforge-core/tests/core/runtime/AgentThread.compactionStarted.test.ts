import { contextCompaction } from '../../../src/core/capabilities/builtins/ContextCompaction';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* answerStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'answer' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

describe('AgentThread compaction start', () => {
  it('says compaction started before the summary call and before the context is replaced', async () => {
    const events: AgentThreadEvent[] = [];
    let seenWhenSummarizing: string[] = [];
    const modelClient: ILLM = {
      create: jest.fn(answerStream),
      createNonStream: jest.fn().mockImplementation(async () => {
        seenWhenSummarizing = events.map(event => event.type);
        return {
          output: { role: 'assistant', content: 'not a usable summary' },
          usage: getEmptyUsage(),
          finish_reason: 'stop',
        };
      }),
    };
    const definition = {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      modelProperties: undefined,
      modelParams: undefined,
    };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition,
      context: [
        { role: 'user', content: 'An earlier question.' },
        { role: 'assistant', content: 'An earlier answer.' },
        { role: 'user', content: 'A new question.' },
      ],
      capabilities: [
        contextCompaction({
          logger: undefined,
          definition: { modelId: undefined, configuredModels: undefined, modelClient },
          compactionThresholdTokens: 1,
        }),
      ],
    });

    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    const types = events.map(event => event.type);
    const started = events.find(event => event.type === EventType.AGENT_CONTEXT_COMPACTION_STARTED);
    expect(started).toMatchObject({ thread_id: 'main', mode: 'conversation' });
    expect(seenWhenSummarizing).toContain(EventType.AGENT_CONTEXT_COMPACTION_STARTED);
    expect(seenWhenSummarizing).not.toContain(EventType.AGENT_CONTEXT_OVERWRITE);
    expect(types.indexOf(EventType.AGENT_CONTEXT_COMPACTION_STARTED)).toBeLessThan(
      types.indexOf(EventType.AGENT_CONTEXT_COMPACTION),
    );
  });
});
