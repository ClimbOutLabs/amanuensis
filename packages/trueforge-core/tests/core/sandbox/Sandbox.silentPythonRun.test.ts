import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { RunCodeBackend } from '../../../src/core/sandbox/driver/RunCodeService';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, type BoundRepository } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';
import { realCommandExec } from './realCommandExec';

const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';

/** A run_code backend that can reach the package gateway, so an install is offered instead of refused. */
const PACKAGE_GATEWAY_RUN_CODE_SERVICE: RunCodeBackend = {
  packageGatewayCapable: true,
  runCode: () => Promise.reject(new Error('run_code is not used in these tests')),
  scrubDispatchErrorText: text => text,
};

/** A plain install with no install scripts: silent with the switch on. */
const SILENT_INSTALL = 'npm install --ignore-scripts humanize';
/** The same install without the ignore flag: it keeps its card. */
const CARDED_INSTALL = 'npm install humanize';

function makeProvider(execCalls: SandboxExecParams[], workspace: string): SandboxProvider {
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec((params: SandboxExecParams): Promise<ExecResult> => {
      execCalls.push(params);
      const result =
        params.command === BOUND_REPOSITORY_STATE_COMMAND
          ? `${workspace}\nmain\n0123456789abcdef\n`
          : params.command === 'git rev-parse --show-toplevel'
            ? workspace
            : params.command === 'git rev-parse --abbrev-ref HEAD'
              ? 'main'
              : params.command === 'git rev-parse HEAD'
                ? '0123456789abcdef'
                : params.command === 'git rev-parse --absolute-git-dir'
                  ? join(workspace, '.git')
                  : params.command.startsWith('ls -di -- .git ')
                    ? `11 .git\n12 ${join(workspace, '.git')}`
                    : '';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => workspace,
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

/**
 * A sandbox bound to a repository that allows downloads, over a real workspace whose host has the switch on or off.
 * Installs are refused in a chat whose repository does not allow downloads, so the bound repository is required.
 */
function setUp({ sandboxWithoutAsking }: { sandboxWithoutAsking: boolean }): {
  sandbox: Sandbox;
  execCalls: SandboxExecParams[];
  cleanup: () => void;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-silent-run-'));
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.16.0' }));
  const boundRepository: BoundRepository = {
    repository_id: 'repo-1',
    revision: 1,
    workspace_cwd: workspace,
    commands: [],
  };
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.sandboxWithoutAsking = () => Promise.resolve(sandboxWithoutAsking);
  const execCalls: SandboxExecParams[] = [];
  const sandbox = new Sandbox({
    provider: makeProvider(execCalls, workspace),
    boundRepository,
    loadBoundRepository: async () => boundRepository,
    workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: 'test-replica',
    loadPackageMirrorToken: async () => 'mirror-token',
    loadPackageDownloadsAllowed: async () => true,
    runCodeService: PACKAGE_GATEWAY_RUN_CODE_SERVICE,
    allowPackageDownloads: async () => undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: workspace,
      services,
    }),
  });
  return { sandbox, execCalls, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

function execCall(command: string) {
  return {
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: { intent: 'Install the project packages', purpose: 'execute', command },
  };
}

describe('a silent sandbox run reaches the provider only as a silent run', () => {
  it('runs a plain install with the switch on, without an approval card', async () => {
    const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: true });
    try {
      const info = await sandbox.toolCallInfo(execCall(SILENT_INSTALL));
      expect(info.is_approval_required).toBe(false);
      await sandbox.callTool(execCall(SILENT_INSTALL));
      expect(execCalls.map(call => call.command)).toContain(SILENT_INSTALL);
    } finally {
      cleanup();
    }
  });

  it('holds a carded install until it is approved, and then runs it', async () => {
    const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: true });
    try {
      const info = await sandbox.toolCallInfo(execCall(CARDED_INSTALL));
      expect(info.is_approval_required).toBe(true);
      await sandbox.callTool(execCall(CARDED_INSTALL));
      expect(execCalls.map(call => call.command)).not.toContain(CARDED_INSTALL);

      await sandbox.callTool(execCall(CARDED_INSTALL), { status: 'allow' });
      expect(execCalls.map(call => call.command)).toContain(CARDED_INSTALL);
    } finally {
      cleanup();
    }
  });

  it('asks for the silent install with the switch off', async () => {
    const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: false });
    try {
      const info = await sandbox.toolCallInfo(execCall(SILENT_INSTALL));
      expect(info.is_approval_required).toBe(true);
      await sandbox.callTool(execCall(SILENT_INSTALL));
      expect(execCalls.map(call => call.command)).not.toContain(SILENT_INSTALL);
    } finally {
      cleanup();
    }
  });

  it('refuses a Python script run through exec before it reaches the provider', async () => {
    const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: true });
    try {
      const response = await sandbox.callTool(execCall('python3 agent_tool.py'));
      expect(JSON.stringify(response)).toContain('run_code');
      expect(execCalls).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
