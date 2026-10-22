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

  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function systemPromptFor(definition: {
  instruction?: string;
  identity?: { assistantName?: string | null; personName?: string | null };
}) {
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
      toolSets: [],
      ...definition,
    },
    context: [{ role: 'user', content: 'hi' }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }
  const systemMessage = create.mock.calls[0]?.[0].messages.find(m => m.role === 'system');
  return String(systemMessage?.content);
}

describe('AgentThread root identity', () => {
  it('names the assistant and the person from the definition', async () => {
    const system = await systemPromptFor({ identity: { assistantName: 'Nata', personName: 'Maya' } });

    expect(system).toContain("You are Nata, Maya's chief of staff.");
    expect(system).not.toContain('You are the Agent');
  });

  it('falls back to the default assistant and neutral wording when the definition has no identity', async () => {
    const system = await systemPromptFor({});

    expect(system).toContain('You are Aman, chief of staff to the person you work for.');
  });

  it('keeps the persona or agent instructions after the identity', async () => {
    const system = await systemPromptFor({
      identity: { assistantName: 'Nata', personName: 'Maya' },
      instruction: 'Speak like a pirate.',
    });

    expect(system).toContain('Speak like a pirate.');
    expect(system.indexOf("You are Nata, Maya's chief of staff.")).toBeLessThan(system.indexOf('Speak like a pirate.'));
  });
});
