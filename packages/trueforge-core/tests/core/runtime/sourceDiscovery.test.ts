import type { LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { createSourceDiscoveryContract } from '../../../src/core/runtime/contextUtils';
import { createSandboxExecDescription } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

describe('source discovery contract at the model request boundary', () => {
  it('is present in the host-owned system prompt without restricting coding URLs', async () => {
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
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
        modelId: undefined,
        configuredModels: undefined,
        modelClient: { create, createNonStream: jest.fn() },
        instruction: 'test',
        toolSets: [],
      },
      context: [{ role: 'user', content: 'Look up the release notes.' }],
    });

    const execution = thread.execute({ signal: new AbortController().signal });
    for await (const _event of execution) {
      // Drain the real request so the assertion observes the sent system prompt.
    }

    const request = create.mock.calls[0]?.[0];
    // The system prompt and the per-reply block, where the routed web bundle brings its guidance.
    const systemMessage = {
      content: (request?.messages ?? [])
        .flatMap(message => (message.role === 'system' && typeof message.content === 'string' ? [message.content] : []))
        .join('\n'),
    };
    expect(systemMessage?.content).toContain('<source-discovery>');
    // No sandbox in this chat or on the server: the contract must not name an exec tool, and the server-level
    // no-sandbox line says the server has no place to run commands.
    expect(systemMessage?.content).toContain(createSourceDiscoveryContract({ shellCanFetch: false }).trim());
    expect(systemMessage?.content).not.toContain('sandbox exec tool');
    expect(systemMessage?.content).toContain('<no-sandbox>');
    expect(systemMessage?.content).toContain(
      'This Aman has no place to run commands, so I cannot clone or run code here. You can run the command yourself:',
    );
    expect(systemMessage?.content).not.toContain('<sandbox-off>');
    expect(systemMessage?.content).not.toContain('Add-ons');
    expect(systemMessage?.content).not.toContain('turn on the Sandbox switch');
    expect(systemMessage?.content).not.toContain('Work on a repo');
    expect(systemMessage?.content).not.toContain('Settings');
    expect(systemMessage?.content).toContain('URLs');
    expect(systemMessage?.content).not.toContain('already identified source');
    // Without a sandbox the contract names no sandbox at all, guessed URLs included.
    expect(systemMessage?.content).toContain('discovers or validates a guessed URL. A URL alone');
    expect(systemMessage?.content).not.toContain('the sandbox does not discover');
    expect(systemMessage?.content).toContain('A URL alone is not evidence');
    expect(systemMessage?.content).toContain('no permitted capability can obtain them');
    // A known URL is never a substitute for retrieval: the claim waits for contents either way.
    expect(systemMessage?.content).toContain('knowing where a source lives never substitutes for reading it');
    expect(systemMessage?.content).toContain('do not make the claim. Either retrieve them first');
    // With no sandbox there is no exec-based retrieval, so the clause is left out entirely.
    expect(systemMessage?.content).not.toContain(
      'the sandbox exec tool when it retrieves an already identified source',
    );
    const execDescription = createSandboxExecDescription({ offline: false });
    expect(execDescription).toContain('provides retrieval');
    expect(execDescription).toContain('already identified public source');
    expect(execDescription).toContain('does not provide search or discovery');
    expect(execDescription).toContain('PermissionGate admission');
    expect(execDescription).toContain('separate tool calls in one response');
    expect(execDescription).toContain('runs read-only calls concurrently');
    // Searches about what is current carry the present year; dated or historical questions keep
    // their own period.
    expect(systemMessage?.content).toContain('put the current year from the date given above into the search query');
    expect(systemMessage?.content).toContain(
      'When the question names a period or is about the past, search that period instead',
    );
  });
});
