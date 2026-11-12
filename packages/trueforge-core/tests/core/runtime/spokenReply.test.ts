import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
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

/** The per-reply block the model receives for one turn. */
async function replyContext(spokenReply: boolean | undefined): Promise<string> {
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
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      spokenReply,
    },
    context: [{ role: 'user', content: 'Talk to me' }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }
  const request = create.mock.calls[0]?.[0];
  const block = request?.messages.find(m => m.role === 'system' && String(m.content).includes('<reply-context>'));
  return String(block?.content);
}

describe('AgentThread spoken reply', () => {
  it('tells the model a spoken message is answered aloud, in short plain sentences', async () => {
    const context = await replyContext(true);

    expect(context).toContain('<spoken-reply>');
    expect(context).toContain('the app reads your reply aloud');
    expect(context).toContain('Never say you cannot speak');
  });

  it('says nothing about speech for a typed message', async () => {
    expect(await replyContext(undefined)).not.toContain('<spoken-reply>');
    expect(await replyContext(false)).not.toContain('<spoken-reply>');
  });
});
