import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { PLAIN_SPEECH_PROMPT } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger, makeStubPublicSandbox } from '../harnessMocks';

async function systemPrompt(input: {
  instruction: string;
  network?: 'none' | undefined;
  message?: string | undefined;
}): Promise<string> {
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
      modelId: undefined,
      configuredModels: undefined,
      modelClient,
      instruction: input.instruction,
      toolSets: [],
    },
    context: [{ role: 'user', content: input.message ?? 'Fetch https://example.com for me.' }],
    sandbox: makeStubPublicSandbox({ network: input.network }),
  });

  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertion is on the request sent to the model.
  }

  const content = create.mock.calls[0]?.[0].messages.find(message => message.role === 'system')?.content;
  return typeof content === 'string' ? content : '';
}

describe('host-owned plain speech rule', () => {
  it.each(['You are a terse senior engineer. Use precise technical terms.', 'test'])(
    'is in the system prompt whatever the persona says: %s',
    async instruction => {
      const prompt = await systemPrompt({ instruction });
      expect(prompt).toContain('<plain-speech>');
      expect(prompt).toContain(PLAIN_SPEECH_PROMPT.trim());
      expect(prompt).toContain('Do not write the result of a tool call before the result arrives');
      expect(prompt).toContain('never say an action is waiting for approval unless the result says so');
    },
  );

  it('keeps the shell out of the source contract and tells the model the sandbox is offline', async () => {
    const offline = await systemPrompt({ instruction: 'test', network: 'none' });
    expect(offline).not.toContain('the sandbox exec tool when it retrieves');
    expect(offline).not.toContain('curl');
    expect(offline).toContain('Retrieval capabilities include search, browsing, lookup, and fetch tools.');

    // The exec tool is named only once the sandbox bundle is loaded: a message that routes to it loads it first.
    const online = await systemPrompt({ instruction: 'test', message: 'Run a script to fetch https://example.com.' });
    expect(online).toContain('the sandbox exec tool when it retrieves an already identified source');
    expect(online).toContain('curl');

    const unrouted = await systemPrompt({ instruction: 'test' });
    expect(unrouted).not.toContain('the sandbox exec tool when it retrieves');
  });
});
