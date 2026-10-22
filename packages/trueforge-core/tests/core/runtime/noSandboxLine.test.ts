import type { LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

/** The system prompt one root chat with no sandbox object sends, for a server that has or lacks a sandbox. */
async function systemPromptFor(input: { serverSandboxAvailable: boolean | undefined }): Promise<string> {
  const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    turnToolCallLedger: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    serverSandboxAvailable: input.serverSandboxAvailable,
    definition: {
      modelId: undefined,
      configuredModels: undefined,
      modelClient: { create, createNonStream: jest.fn() },
      instruction: 'test',
      toolSets: [],
    },
    context: [{ role: 'user', content: 'Clone the repository https://github.com/acme/tool.' }],
  });
  const execution = thread.execute({ signal: new AbortController().signal });
  for await (const _event of execution) {
    // Drain the real request so the assertion observes the sent system prompt.
  }
  const request = create.mock.calls[0]?.[0];
  const systemMessage = request?.messages.find(message => message.role === 'system');
  return typeof systemMessage?.content === 'string' ? systemMessage.content : '';
}

describe('no-sandbox line follows the server sandbox status', () => {
  it('names the composer control when the server has a sandbox that is off for this chat', async () => {
    const prompt = await systemPromptFor({ serverSandboxAvailable: true });

    expect(prompt).toContain('<sandbox-off>');
    expect(prompt).toContain('open Add-ons in the composer, go to Connectors, and turn on the Sandbox switch');
    expect(prompt).toContain('available on this Aman but is turned off for this chat or persona');
    expect(prompt).toContain('Do not say the sandbox is missing');
    expect(prompt).not.toContain('<no-sandbox>');
    expect(prompt).not.toContain('has no place to run commands');
  });

  it('says plainly that the server has no place to run commands when it has no sandbox', async () => {
    const prompt = await systemPromptFor({ serverSandboxAvailable: false });

    expect(prompt).toContain('<no-sandbox>');
    expect(prompt).toContain(
      'This Aman has no place to run commands, so I cannot clone or run code here. You can run the command yourself:',
    );
    expect(prompt).toContain('git clone with the repository URL they gave');
    expect(prompt).not.toContain('<sandbox-off>');
    expect(prompt).not.toContain('Add-ons');
    expect(prompt).not.toContain('turn on the Sandbox switch');
  });

  it('treats an unreported server status as no sandbox on the server', async () => {
    const prompt = await systemPromptFor({ serverSandboxAvailable: undefined });

    expect(prompt).toContain('<no-sandbox>');
    expect(prompt).not.toContain('<sandbox-off>');
  });
});
