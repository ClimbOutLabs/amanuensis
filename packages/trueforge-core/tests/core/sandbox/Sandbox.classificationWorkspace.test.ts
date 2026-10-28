import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function makeProvider(): SandboxProvider {
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: (): Promise<ExecResult> => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => '/work',
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(workspaceCwd: string | null): Sandbox {
  return new Sandbox({
    provider: makeProvider(),
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: workspaceCwd,
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    }),
  });
}

describe('the workspace classification judged against is recorded on the call', () => {
  it('records the provider default when the session has no workspace bound', async () => {
    const sandbox = makeSandbox(null);
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Look at the files', purpose: 'verify', command: 'ls' },
    });
    expect(info.workspace_cwd).toBe('/work');
  });

  it('records the session workspace ahead of the provider default', async () => {
    const sandbox = makeSandbox('/session-work');
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Look at the files', purpose: 'verify', command: 'ls' },
    });
    expect(info.workspace_cwd).toBe('/session-work');
  });

  it('records nothing when no classification ran', async () => {
    const sandbox = new Sandbox({
      provider: makeProvider(),
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Look at the files', purpose: 'verify', command: 'ls' },
    });
    expect(info.workspace_cwd).toBeUndefined();
  });
});
