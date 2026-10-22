import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const call: {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
} = {
  id: 'metadata-failure',
  type: 'function',
  function: {
    name: 'exec',
    arguments: JSON.stringify({
      intent: 'Inspect repository status',
      purpose: 'inspect',
      command: 'git status --short',
      cwd: '/tmp/repo',
    }),
  },
};

async function* toolStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'tool-chunk',
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
    choices: [{ index: 0, delta: { role: 'assistant', content: 'The tool was unavailable.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: 'The tool was unavailable.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('tool metadata preparation failure boundary', () => {
  it('records a canonical never-ran result without dispatching or aborting the turn', async () => {
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
    jest.spyOn(sandbox, 'toolCallInfo').mockRejectedValue(new Error('metadata unavailable'));
    const create = jest.fn().mockImplementationOnce(toolStream).mockImplementationOnce(finalStream);
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
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      sandbox,
      context: [{ role: 'user', content: 'inspect the repository' }],
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(provider.exec).not.toHaveBeenCalled();
    expect(events.filter(event => event.type === EventType.TOOL_EXECUTION_STARTED)).toHaveLength(0);
    expect(events.filter(event => event.type === EventType.TOOL_RESPONSE_V2)).toEqual([
      expect.objectContaining({
        tool_call_id: 'metadata-failure',
        disposition: 'never_ran',
        remediation: expect.objectContaining({ reason_code: 'tool_pre_dispatch_failed' }),
      }),
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.map(event => event.type)).toContain(InternalEventType.AGENT_DONE);
  });
});
