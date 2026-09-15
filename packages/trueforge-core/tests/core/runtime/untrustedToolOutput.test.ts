import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { UNTRUSTED_TOOL_OUTPUT_PROMPT } from '../../../src/core/runtime/contextUtils';
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

  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('AgentThread untrusted tool output instruction', () => {
  it('includes the data-not-instructions warning in the system prompt sent to the model', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
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
      context: [{ role: 'user', content: 'hi' }],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).toContain('<untrusted-tool-output>');
    expect(systemMessage?.content).toContain(UNTRUSTED_TOOL_OUTPUT_PROMPT.trim());
  });
});
