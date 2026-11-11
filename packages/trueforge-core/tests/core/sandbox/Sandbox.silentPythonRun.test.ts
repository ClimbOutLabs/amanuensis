import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { RunCodeBackend } from '../../../src/core/sandbox/driver/RunCodeService';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  type BoundRepository,
} from '../../../src/core/sandbox/Sandbox';
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

/** A plain install with no install scripts. */
const PLAIN_INSTALL = 'npm install --ignore-scripts humanize';
/** The same install without the ignore flag. */
const SCRIPTED_INSTALL = 'npm install humanize';

function makeProvider(input: {
  execCalls: SandboxExecParams[];
  workspace: string;
  /** Whether the provider says nothing run in its sandbox can reach a network. */
  noNetwork: boolean;
}): SandboxProvider {
  const { execCalls, workspace } = input;
  return {
    type: 'test',
    network: input.noNetwork ? 'none' : undefined,
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
 * By default the provider says its sandbox has no network, as the installed one does, and downloads are allowed.
 */
function setUp({
  sandboxWithoutAsking,
  noNetwork = true,
  downloadsAllowed = true,
  skillSites = [],
}: {
  sandboxWithoutAsking: boolean;
  noNetwork?: boolean;
  downloadsAllowed?: boolean;
  skillSites?: readonly string[];
}): {
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
    provider: makeProvider({ execCalls, workspace, noNetwork }),
    boundRepository,
    loadBoundRepository: async () => boundRepository,
    workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: 'test-replica',
    loadPackageMirrorToken: async () => (downloadsAllowed ? 'mirror-token' : undefined),
    loadPackageDownloadsAllowed: async () => downloadsAllowed,
    loadSkillNetworkGrant: async () =>
      skillSites.length === 0 ? undefined : { token: 'skill-token', hosts: skillSites },
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

describe('a package install asks before it reaches the provider', () => {
  it.each([PLAIN_INSTALL, SCRIPTED_INSTALL])(
    'holds %s with the switch on until it is approved, and then runs it',
    async command => {
      const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: true });
      try {
        const info = await sandbox.toolCallInfo(execCall(command));
        expect(info.is_approval_required).toBe(true);
        await sandbox.callTool(execCall(command));
        expect(execCalls.map(call => call.command)).not.toContain(command);

        await sandbox.callTool(execCall(command), { status: 'allow' });
        expect(execCalls.map(call => call.command)).toContain(command);
      } finally {
        cleanup();
      }
    },
  );

  it('asks for an install with the switch off', async () => {
    const { sandbox, execCalls, cleanup } = setUp({ sandboxWithoutAsking: false });
    try {
      const info = await sandbox.toolCallInfo(execCall(PLAIN_INSTALL));
      expect(info.is_approval_required).toBe(true);
      await sandbox.callTool(execCall(PLAIN_INSTALL));
      expect(execCalls.map(call => call.command)).not.toContain(PLAIN_INSTALL);
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

describe('a new file is placed without a card only where nothing run in the sandbox can reach a network', () => {
  const WRITE_CALL = {
    name: SANDBOX_WRITE_FILE_TOOL_NAME,
    arguments: { intent: 'Save the notes', path: 'notes.txt', content: 'hello\n' },
  };

  it('is placed without a card with the switch on, in a sandbox with no network and no downloads allowed', async () => {
    const { sandbox, cleanup } = setUp({ sandboxWithoutAsking: true, downloadsAllowed: false });
    try {
      const info = await sandbox.toolCallInfo(WRITE_CALL);
      expect(info).toMatchObject({ tier: 1, tier_reason: 'sandbox_file_write', tier3_card: null });
    } finally {
      cleanup();
    }
  });

  it.each([
    [
      'the switch on, in a sandbox that may reach a network',
      { sandboxWithoutAsking: true, noNetwork: false, downloadsAllowed: false },
    ],
    [
      'the switch on, where package downloads are allowed for the repository',
      { sandboxWithoutAsking: true, downloadsAllowed: true },
    ],
    [
      'the switch on, where a skill may reach the sites approved for it',
      { sandboxWithoutAsking: true, downloadsAllowed: false, skillSites: ['api.example.com'] },
    ],
    ['the switch off, in a sandbox with no network', { sandboxWithoutAsking: false, downloadsAllowed: false }],
  ])('gets a card with %s', async (_label, options) => {
    const { sandbox, cleanup } = setUp(options);
    try {
      const info = await sandbox.toolCallInfo(WRITE_CALL);
      expect(info).toMatchObject({ tier: 2, tier_reason: 'sandbox_write' });
      expect(info.tier3_card?.plain_what).toBe('Change `notes.txt` in your workspace?');
      expect(typeof info.approval_token_id).toBe('string');
    } finally {
      cleanup();
    }
  });
});
