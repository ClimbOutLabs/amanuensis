import { Sandbox, SANDBOX_APPLY_PATCH_TOOL_NAME, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import type { SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function makeSandbox(): Sandbox {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: () => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used' } }),
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
  return new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('Sandbox mint canonical params', () => {
  test('exec arguments are their own canonical params', () => {
    const args = { intent: 'look', purpose: 'inspect', command: 'ls', cwd: '/work' };
    expect(makeSandbox().mintCanonicalParams({ name: SANDBOX_EXEC_TOOL_NAME, arguments: args })).toEqual(args);
  });

  test('wire arguments derive the params recorded on the call info', async () => {
    const sandbox = makeSandbox();
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: {
        intent: 'fix',
        cwd: '/work',
        patch_lines: ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-one', '+two'],
      },
    };
    const info = await sandbox.toolCallInfo(call);
    expect(info.mint_canonical_params).toEqual(sandbox.mintCanonicalParams(call));
    expect(sandbox.mintCanonicalParams(call)).toHaveProperty('patch');
  });
});
