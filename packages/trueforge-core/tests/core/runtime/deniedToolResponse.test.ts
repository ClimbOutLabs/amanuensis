import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

async function* editStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: 'denied-edit',
    type: 'function' as const,
    function: {
      name: 'exec',
      arguments: JSON.stringify({
        intent: 'Edit source',
        purpose: 'edit',
        command: 'cp source target',
        cwd: '/tmp/repo',
      }),
    },
  };
  yield {
    id: 'edit-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* finalStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'I did not make the change.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: 'I did not make the change.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('denied tool result boundary', () => {
  it('does not dispatch and emits exactly one canonical v2 denial', async () => {
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: jest.fn(),
      getImageBuildStatus: jest.fn(),
      createSandbox: jest.fn(() => Promise.resolve({ sandboxId: 'sandbox-1' })),
      exec: jest.fn(),
      acknowledgeWorkspaceTermination: jest.fn(() => Promise.resolve()),
      executeVerifiedWorkspaceCommit: () =>
        Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
      getAdditionalInstructions: () => undefined,
      getWorkspaceDir: () => undefined,
      getToolResultDumpDir: () => '/tmp/tool-results',
      getGitCredentialsPath: () => '/tmp/.git-credentials',
      getFileUploadsDir: () => '/tmp/uploads',
      getSkillsDir: () => '/opt/tfy/skills',
      getSkillDownloaderPath: () => '/opt/tfy/git_downloader.py',
      downloadFile: jest.fn(),
      uploadFile: jest.fn(() => Promise.resolve()),
      createCodeModeTransport: jest.fn(),
    };
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const create = jest.fn().mockImplementationOnce(editStream).mockImplementationOnce(finalStream);
    const modelClient: ILLM = { create, createNonStream: jest.fn(), countTokens: jest.fn().mockImplementation((text: string) => Promise.resolve(Math.ceil(text.length / 4))) };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'edit the repository' }],
    });

    const firstEvents = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) firstEvents.push(event);
    expect(firstEvents.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);

    for await (const event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'denied-edit',
        approval: { status: 'deny', reason: 'Not this change' },
      },
    ])) {
      void event;
    }

    const continuationEvents = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      continuationEvents.push(event);
    }
    const terminalResults = continuationEvents.filter(event => event.type === EventType.TOOL_RESPONSE_V2);

    expect(provider.exec).not.toHaveBeenCalled();
    expect(terminalResults).toHaveLength(1);
    expect(terminalResults[0]).toMatchObject({
      tool_call_id: 'denied-edit',
      disposition: 'denied',
      admission_provenance: { source: 'user_approval', decision: 'deny' },
    });
    expect(continuationEvents.map(event => String(event.type))).not.toContain(EventType.TOOL_RESPONSE);
  });
});
