import type { LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { SOURCE_DISCOVERY_CONTRACT } from '../../../src/core/runtime/contextUtils';
import { SANDBOX_EXEC_DESCRIPTION } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

describe('source discovery contract at the model request boundary', () => {
  it('is present in the host-owned system prompt without restricting coding URLs', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      context: [{ role: 'user', content: 'hi' }],
    });

    const execution = thread.execute({ signal: new AbortController().signal });
    for await (const _event of execution) {
      // Drain the real request so the assertion observes the sent system prompt.
    }

    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(message => message.role === 'system');
    expect(systemMessage?.content).toContain('<source-discovery>');
    expect(systemMessage?.content).toContain(SOURCE_DISCOVERY_CONTRACT.trim());
    expect(systemMessage?.content).toContain('URLs');
    expect(systemMessage?.content).toContain('curl');
    expect(systemMessage?.content).toContain('already identified source');
    expect(systemMessage?.content).toContain('does not discover or validate a guessed URL');
    expect(systemMessage?.content).toContain('A URL alone is not evidence');
    expect(systemMessage?.content).toContain('no permitted capability can obtain them');
    // A known URL is never a substitute for retrieval: the claim waits for contents either way.
    expect(systemMessage?.content).toContain('knowing where a source lives never substitutes for reading it');
    expect(systemMessage?.content).toContain('do not make the claim. Either retrieve them first');
    // The sandbox exec tool is named as a retrieval capability, so an agent with curl and no
    // dedicated search tool is told to fetch, not to abstain.
    expect(systemMessage?.content).toContain('the sandbox exec tool when it retrieves an already identified source');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('provides retrieval');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('already identified public source');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('does not provide search or discovery');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('PermissionGate admission');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('separate tool calls in one response');
    expect(SANDBOX_EXEC_DESCRIPTION).toContain('runs read-only calls concurrently');
    // Searches about what is current carry the present year; dated or historical questions keep
    // their own period.
    expect(systemMessage?.content).toContain('put the current year from the date given above into the search query');
    expect(systemMessage?.content).toContain(
      'When the question names a period or is about the past, search that period instead',
    );
  });
});
