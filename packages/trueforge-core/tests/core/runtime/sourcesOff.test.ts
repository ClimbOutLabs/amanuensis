import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

/** Runs one turn and returns the system prompt the model was sent. */
async function systemPromptFor(input: {
  attached: string[];
  setUp: readonly string[] | undefined;
  readOnly?: boolean;
}): Promise<string> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    return finalAnswerStream('Done.');
  });
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
      toolSets: input.attached.map(name => makeMockIMCPServer({ name, preload: true })),
      setUpConnectorNames: input.setUp,
      readOnly: input.readOnly,
    },
    context: [{ role: 'user', content: 'Add lunch with Ana to my calendar for Friday.' }],
  });
  for await (const _event of thread.execute({ signal: new AbortController().signal })) {
    // Draining is enough; the assertions are on the request sent to the model.
  }
  const system = requests[0]?.messages.find(message => message.role === 'system')?.content;
  return typeof system === 'string' ? system : '';
}

describe('a chat where mail or calendar is not attached', () => {
  it('tells the model how to turn Calendar on when it is set up but off for this chat', async () => {
    const prompt = await systemPromptFor({ attached: ['Email'], setUp: ['Email', 'Calendar'] });
    expect(prompt).toContain('<sources-off>');
    expect(prompt).toContain('The Calendar connector is set up but turned off for this chat.');
    expect(prompt).toContain('opens Add-ons in the composer, goes to Connectors, and turns on Calendar');
    expect(prompt).toContain('Never offer a schedule, a helper, a search, or another tool in its place');
    expect(prompt).not.toContain('The Email connector');
  });

  it('points to Settings when Calendar is not set up at all', async () => {
    const prompt = await systemPromptFor({ attached: ['Email'], setUp: ['Email'] });
    expect(prompt).toContain(
      "No connector named 'Calendar' is set up. The person can set one up in Settings, Connectors.",
    );
  });

  it('claims nothing when the host does not report what is set up', async () => {
    const prompt = await systemPromptFor({ attached: [], setUp: undefined });
    expect(prompt).not.toContain('<sources-off>');
  });

  it('adds no section when both are attached', async () => {
    const prompt = await systemPromptFor({ attached: ['Email', 'Calendar'], setUp: ['Email', 'Calendar'] });
    expect(prompt).not.toContain('<sources-off>');
  });

  it('adds no section for a read-only agent, which offers no connectors at all', async () => {
    const prompt = await systemPromptFor({ attached: [], setUp: ['Email', 'Calendar'], readOnly: true });
    expect(prompt).not.toContain('<sources-off>');
  });
});
