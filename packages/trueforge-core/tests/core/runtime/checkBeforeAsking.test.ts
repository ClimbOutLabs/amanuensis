import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { CHECK_BEFORE_ASKING_PROMPT } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

describe('AgentThread check-before-asking instruction', () => {
  it('tells the model to check its tasks and memory before asking the user', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
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
      definition: { modelId: undefined, configuredModels: undefined, modelClient, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'What is still open on the kitchen work?' }],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('<check-before-asking>');
    expect(systemMessage?.content).toContain(CHECK_BEFORE_ASKING_PROMPT.trim());
    // The guidance is general: it names the places to check, not one scenario.
    expect(CHECK_BEFORE_ASKING_PROMPT).toContain('spaces');
    expect(CHECK_BEFORE_ASKING_PROMPT).toContain('memory');
  });
});
