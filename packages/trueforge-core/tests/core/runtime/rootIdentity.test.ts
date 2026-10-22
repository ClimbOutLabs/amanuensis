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
  // The static instruction is the first system message; the per-reply block follows it.
  const systemMessages = (create.mock.calls[0]?.[0].messages ?? [])
    .filter(m => m.role === 'system')
    .map(m => String(m.content));
  return { staticInstruction: systemMessages[0] ?? '', replyContext: systemMessages[1] ?? '' };
}

describe('AgentThread root identity', () => {
  it('keeps the person out of the static identity and names them in the per-reply block', async () => {
    const { staticInstruction, replyContext } = await systemPromptFor({
      identity: { assistantName: 'Nata', personName: 'Maya' },
    });

    expect(staticInstruction).toContain('You are Nata, chief of staff to the person you work for.');
    expect(staticInstruction).not.toContain('Maya');
    expect(replyContext).toContain('<reply-context>');
    expect(replyContext).toContain('The person you work for is Maya.');
  });

  it('falls back to the default assistant and neutral wording when the definition has no identity', async () => {
    const { staticInstruction, replyContext } = await systemPromptFor({});

    expect(staticInstruction).toContain('You are Aman, chief of staff to the person you work for.');
    expect(replyContext).not.toContain('The person you work for is');
  });

  it('keeps the persona or agent instructions after the identity', async () => {
    const { staticInstruction } = await systemPromptFor({
      identity: { assistantName: 'Nata', personName: 'Maya' },
      instruction: 'Speak like a pirate.',
    });

    expect(staticInstruction).toContain('Speak like a pirate.');
    expect(staticInstruction.indexOf('You are Nata')).toBeLessThan(staticInstruction.indexOf('Speak like a pirate.'));
  });
});
