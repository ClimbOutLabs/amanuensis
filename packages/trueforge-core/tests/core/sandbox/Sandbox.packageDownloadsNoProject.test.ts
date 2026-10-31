import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import { isCallToolResponseResult, type CallToolResponse } from '../../../src/core/mcp/IMCPServer';
import type { RunCodeResult } from '../../../src/core/sandbox/driver/RunCodeSchemas';
import type { RunCodeBackend, RunCodeCallOptions } from '../../../src/core/sandbox/driver/RunCodeService';
import { PACKAGE_GIT_DEPENDENCY_MESSAGE } from '../../../src/core/sandbox/packageMirrors';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  type BoundRepository,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';
import { realCommandExec } from './realCommandExec';

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repo-1',
  revision: 1,
  workspace_cwd: '/work',
  commands: [],
};

const NO_PROJECT_CARD_WHAT =
  'Aman wants to download packages from the public package sites (PyPI) in your chats that are not working on a project.';

/** One call the fake run_code backend recorded: the raw input the backend contract hands it, and its call options. */
type RecordedRunCodeCall = { input: unknown; options: RunCodeCallOptions | undefined };

/** A run_code backend that records what it was handed and can reach the package gateway. */
function makeRunCodeService(calls: RecordedRunCodeCall[]): RunCodeBackend {
  return {
    packageGatewayCapable: true,
    runCode: (input, options) => {
      calls.push({ input, options });
      const result: RunCodeResult = {
        status: 'ok',
        exit_code: 0,
        stdout: '',
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        files_out: [],
        harvest_warnings: [],
      };
      return Promise.resolve(result);
    },
    scrubDispatchErrorText: text => text,
  };
}

/** A run_code backend on the Docker driver, which cannot reach the package gateway. */
const DOCKER_RUN_CODE_SERVICE: RunCodeBackend = {
  packageGatewayCapable: false,
  runCode: () => Promise.reject(new Error('run_code is not used in these tests')),
  scrubDispatchErrorText: text => text,
};

function makeProvider(
  execCalls: SandboxExecParams[],
  files?: Record<string, string>,
  workspaceDir = '/work',
): SandboxProvider {
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec((params: SandboxExecParams): Promise<ExecResult> => {
      execCalls.push(params);
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? workspaceDir
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? 'main'
            : params.command === 'git rev-parse HEAD'
              ? '0123456789abcdef'
              : params.command === 'git rev-parse --absolute-git-dir'
                ? `${workspaceDir}/.git`
                : '';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => workspaceDir,
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(async (params: { path: string }) => Buffer.from(files?.[params.path] ?? '')),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(input: {
  execCalls: SandboxExecParams[];
  allowed: () => boolean;
  allowPackageDownloads: () => Promise<void>;
  boundRepository?: BoundRepository | undefined;
  files?: Record<string, string> | undefined;
  runCodeCalls?: RecordedRunCodeCall[] | undefined;
  runCodeService?: RunCodeBackend | undefined;
  loaders?: boolean | undefined;
  sandboxWithoutAsking?: boolean | undefined;
  workspaceDir?: string | undefined;
}): Sandbox {
  const loaders = input.loaders ?? true;
  const boundRepository =
    input.boundRepository === undefined || input.workspaceDir === undefined
      ? input.boundRepository
      : { ...input.boundRepository, workspace_cwd: input.workspaceDir };
  return new Sandbox({
    provider: makeProvider(input.execCalls, input.files, input.workspaceDir),
    boundRepository,
    loadBoundRepository: boundRepository === undefined ? undefined : async () => boundRepository,
    workspaceVerificationCoordinator: boundRepository === undefined ? undefined : new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: boundRepository === undefined ? undefined : 'test-replica',
    loadPackageMirrorToken: loaders ? async () => (input.allowed() ? 'mirror-token' : undefined) : undefined,
    loadPackageDownloadsAllowed: loaders ? async () => input.allowed() : undefined,
    allowPackageDownloads: loaders ? input.allowPackageDownloads : undefined,
    runCodeService: input.runCodeService ?? makeRunCodeService(input.runCodeCalls ?? []),
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: input.workspaceDir ?? '/work',
      services: {
        ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
        ...(input.sandboxWithoutAsking === undefined
          ? {}
          : { sandboxWithoutAsking: () => Promise.resolve(input.sandboxWithoutAsking ?? false) }),
      },
    }),
  });
}

const PIP_CALL = {
  name: SANDBOX_EXEC_TOOL_NAME,
  arguments: { intent: 'Install the packages', purpose: 'execute', command: 'pip install requests' },
};

function resultText(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a tool result');
  }
  const content = response.result.content[0];
  if (content?.type !== 'text') {
    throw new Error('Expected a text tool result');
  }
  return content.text;
}

describe('the first package download in a chat without a project', () => {
  it('shows the download card wording for chats without a project', async () => {
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
    });
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).toBe(NO_PROJECT_CARD_WHAT);
  });

  it('shows the same card for a pip download and a cargo install', async () => {
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
    });
    const pipDownload = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Download the packages', purpose: 'execute', command: 'pip download requests' },
    });
    expect(pipDownload.is_approval_required).toBe(true);
    expect(pipDownload.tier3_card?.plain_what).toBe(NO_PROJECT_CARD_WHAT);
    const cargoInstall = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Install the tool', purpose: 'execute', command: 'cargo install ripgrep' },
    });
    expect(cargoInstall.is_approval_required).toBe(true);
    expect(cargoInstall.tier3_card?.plain_what).toBe(
      'Aman wants to download packages from the public package sites (crates.io) in your chats that are not working on a project.',
    );
  });

  it('is refused with the card while unapproved: nothing runs and nothing is recorded', async () => {
    const execCalls: SandboxExecParams[] = [];
    const allowPackageDownloads = jest.fn(async () => undefined);
    const sandbox = makeSandbox({ execCalls, allowed: () => false, allowPackageDownloads });
    const response = await sandbox.callTool(PIP_CALL);
    if (!('approvalRequired' in response)) {
      throw new Error('Expected the call to wait for approval');
    }
    expect(response.approvalRequired.tool_info.tier3_card?.plain_what).toBe(NO_PROJECT_CARD_WHAT);
    expect(allowPackageDownloads).not.toHaveBeenCalled();
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });

  it('records the allowance on approval, and the approved command itself runs with the mirror token', async () => {
    const execCalls: SandboxExecParams[] = [];
    let allowed = false;
    const allowPackageDownloads = jest.fn(async () => {
      allowed = true;
    });
    const sandbox = makeSandbox({ execCalls, allowed: () => allowed, allowPackageDownloads });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(false);
    const pipExec = execCalls.find(params => params.command === 'pip install requests');
    expect(pipExec?.packageMirrorToken).toBe('mirror-token');
  });

  it('keeps the ordinary card wording once downloads are allowed, and does not record again', async () => {
    const execCalls: SandboxExecParams[] = [];
    const allowPackageDownloads = jest.fn(async () => undefined);
    const sandbox = makeSandbox({ execCalls, allowed: () => true, allowPackageDownloads });
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.tier3_card?.plain_what).not.toContain('not working on a project');
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(false);
    expect(allowPackageDownloads).not.toHaveBeenCalled();
    const pipExec = execCalls.find(params => params.command === 'pip install requests');
    expect(pipExec?.packageMirrorToken).toBe('mirror-token');
  });

  it('asks again on the next install once the allowance is taken back', async () => {
    const execCalls: SandboxExecParams[] = [];
    let allowed = true;
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => allowed,
      allowPackageDownloads: async () => undefined,
    });
    const first = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    if (!isCallToolResponseResult(first)) {
      throw new Error('Expected a tool result');
    }
    expect(first.result.isError).toBe(false);

    // The person turns the allowance off in Settings: the loader now hands out no token, and the
    // next install is back at the first-download card.
    allowed = false;
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).toBe(NO_PROJECT_CARD_WHAT);
    const second = await sandbox.callTool(PIP_CALL);
    if (!('approvalRequired' in second)) {
      throw new Error('Expected the call to wait for approval');
    }
    expect(execCalls.filter(params => params.command === 'pip install requests')).toHaveLength(1);
  });

  it('refuses the approved command with the reason when the allowance cannot be saved', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads: async () => {
        throw new Error('store unavailable');
      },
    });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    expect(resultText(response)).toContain('Aman could not save the download setting. Try again.');
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });

  it('refuses a git dependency named in the workspace files, as in a repo chat', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => true,
      allowPackageDownloads: async () => undefined,
      files: {
        '/work/requirements.txt': 'lib @ git+https://github.com/org/repo\n',
      },
    });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    expect(resultText(response)).toContain(PACKAGE_GIT_DEPENDENCY_MESSAGE);
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });
});

describe('the first download always asks, even when sandbox work runs without asking', () => {
  // A silent install also needs no install-hook files where the install reads from, and a
  // workspace folder that can be resolved; point both at empty real folders so this machine's
  // own files cannot change the answer.
  let home: string;
  let workspace: string;
  let homedirSpy: jest.SpyInstance<string, []>;
  beforeEach(() => {
    home = mkdtempSync(join(os.tmpdir(), 'package-downloads-home-'));
    workspace = mkdtempSync(join(os.tmpdir(), 'package-downloads-workspace-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('shows the card for the first install in a chat without a project, then lets later installs run', async () => {
    const execCalls: SandboxExecParams[] = [];
    let allowed = false;
    const allowPackageDownloads = jest.fn(async () => {
      allowed = true;
    });
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => allowed,
      allowPackageDownloads,
      sandboxWithoutAsking: true,
      workspaceDir: workspace,
    });
    const npmCall = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Install the packages',
        purpose: 'execute',
        command: 'npm install --ignore-scripts left-pad',
      },
    };

    const firstInfo = await sandbox.toolCallInfo(npmCall);
    expect(firstInfo.is_approval_required).toBe(true);
    expect(firstInfo.tier3_card?.plain_what).toBe(
      'Aman wants to download packages from the public package sites (npm) in your chats that are not working on a project.',
    );

    const held = await sandbox.callTool(npmCall);
    if (!('approvalRequired' in held)) {
      throw new Error('Expected the first call to wait for approval');
    }
    expect(execCalls.some(params => params.command === 'npm install --ignore-scripts left-pad')).toBe(false);

    const approved = await sandbox.callTool(npmCall, { status: 'allow' });
    if (!isCallToolResponseResult(approved)) {
      throw new Error('Expected a tool result');
    }
    expect(approved.result.isError).toBe(false);
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);

    const secondInfo = await sandbox.toolCallInfo(npmCall);
    expect(secondInfo.is_approval_required).toBe(false);
    const second = await sandbox.callTool(npmCall);
    if (!isCallToolResponseResult(second)) {
      throw new Error('Expected the second install to run without a card');
    }
    expect(second.result.isError).toBe(false);
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);
    const runs = execCalls.filter(params => params.command === 'npm install --ignore-scripts left-pad');
    expect(runs).toHaveLength(2);
    expect(runs.every(params => params.packageMirrorToken === 'mirror-token')).toBe(true);

    // A pip install still shows its ordinary card once downloads are allowed: pip runs the
    // package's own code, so it is never a silent run. What changed is only that the download
    // card is gone, because the allowance is recorded.
    const pipInfo = await sandbox.toolCallInfo(PIP_CALL);
    expect(pipInfo.is_approval_required).toBe(true);
    expect(pipInfo.tier3_card?.plain_what).toBe('Run this command?');
  });

  it('shows the card for the first install in a repo, then lets later installs run', async () => {
    const execCalls: SandboxExecParams[] = [];
    let allowed = false;
    const allowPackageDownloads = jest.fn(async () => {
      allowed = true;
    });
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => allowed,
      allowPackageDownloads,
      boundRepository: BOUND_REPOSITORY,
      sandboxWithoutAsking: true,
      workspaceDir: workspace,
    });
    const npmCall = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Install the packages',
        purpose: 'execute',
        command: 'npm install --ignore-scripts left-pad',
      },
    };

    const firstInfo = await sandbox.toolCallInfo(npmCall);
    expect(firstInfo.is_approval_required).toBe(true);
    expect(firstInfo.tier3_card?.plain_what).toBe(
      "Aman wants to download this project's packages from the public package sites (npm).",
    );

    const approved = await sandbox.callTool(npmCall, { status: 'allow' });
    if (!isCallToolResponseResult(approved)) {
      throw new Error('Expected a tool result');
    }
    expect(approved.result.isError).toBe(false);
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);

    const secondInfo = await sandbox.toolCallInfo(npmCall);
    expect(secondInfo.is_approval_required).toBe(false);
  });
});

describe('package downloads from run_code in a chat without a project', () => {
  const INSTALLING_CODE = 'pip install requests';

  function runCodeCall() {
    return {
      name: SANDBOX_RUN_CODE_TOOL_NAME,
      arguments: { language: 'python', code: INSTALLING_CODE },
    };
  }

  it('shows the download card wording on a run_code call whose code installs', async () => {
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
    });
    const info = await sandbox.toolCallInfo(runCodeCall());
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).toBe(NO_PROJECT_CARD_WHAT);
  });

  it('records the allowance on approval, and the run itself is provisioned with the mirror token', async () => {
    const runCodeCalls: RecordedRunCodeCall[] = [];
    let allowed = false;
    const allowPackageDownloads = jest.fn(async () => {
      allowed = true;
    });
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => allowed,
      allowPackageDownloads,
      runCodeCalls,
    });
    // Showing the card records nothing and runs nothing; only the approval does.
    const info = await sandbox.toolCallInfo(runCodeCall());
    expect(info.is_approval_required).toBe(true);
    expect(runCodeCalls).toHaveLength(0);
    expect(allowPackageDownloads).not.toHaveBeenCalled();

    const response = await sandbox.callTool(runCodeCall(), { status: 'allow' });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError ?? false).toBe(false);
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);
    expect(runCodeCalls).toHaveLength(1);
    expect(runCodeCalls[0]?.options?.packageMirrorToken).toBe('mirror-token');
  });

  it('hands the run no token while downloads are not allowed', async () => {
    const runCodeCalls: RecordedRunCodeCall[] = [];
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
      runCodeCalls,
    });
    // Code that installs nothing runs as before; with no allowance recorded it simply has no token.
    const response = await sandbox.callTool(
      { name: SANDBOX_RUN_CODE_TOOL_NAME, arguments: { language: 'python', code: 'print(1)' } },
      { status: 'allow' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError ?? false).toBe(false);
    expect(runCodeCalls).toHaveLength(1);
    expect(runCodeCalls[0]?.options?.packageMirrorToken).toBeUndefined();
  });

  it('the mirror token rides only the model\u2019s own calls, never a host-authored one', async () => {
    const execCalls: SandboxExecParams[] = [];
    const runCodeCalls: RecordedRunCodeCall[] = [];
    let allowed = false;
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => allowed,
      allowPackageDownloads: async () => {
        allowed = true;
      },
      runCodeCalls,
    });
    // A script_path run makes the host read the script first (realpath, test -f): host-authored
    // commands like those must never carry the token, in a chat without a project as in one with.
    const response = await sandbox.callTool(
      { name: SANDBOX_RUN_CODE_TOOL_NAME, arguments: { language: 'python', script_path: '/work/install.py' } },
      { status: 'allow' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    const hostCommands = execCalls.filter(params => params.command !== 'pip install requests');
    expect(hostCommands.length).toBeGreaterThan(0);
    expect(hostCommands.every(params => params.packageMirrorToken === undefined)).toBe(true);
  });
});

describe('when downloads cannot work in a chat without a project', () => {
  it.each([
    ['pip install requests', 'pip'],
    ['npm install left-pad', 'npm'],
    ['cargo build', 'cargo'],
    ['go get example.com/mod', 'go'],
  ])(
    'refuses %s before any card when the driver cannot reach the gateway, and never runs it',
    async (command, label) => {
      const execCalls: SandboxExecParams[] = [];
      const sandbox = makeSandbox({
        execCalls,
        allowed: () => false,
        allowPackageDownloads: async () => undefined,
        runCodeService: DOCKER_RUN_CODE_SERVICE,
      });
      const call = {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Install packages', purpose: 'execute', command },
      };
      const info = await sandbox.toolCallInfo(call);
      expect(info.is_approval_required).toBe(false);
      expect(info.tier3_card).toBeUndefined();

      const response = await sandbox.callTool(call);
      if (!isCallToolResponseResult(response)) throw new Error(`Expected a ${label} refusal result`);
      expect(response.result.isError).toBe(true);
      expect(resultText(response)).toContain(
        'Package downloads need the sealed sandbox, and this server is not using it.',
      );
      expect(execCalls.some(params => params.command === command)).toBe(false);
    },
  );

  it('refuses an install before any card when no download wiring exists, and never runs it', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
      loaders: false,
    });
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.is_approval_required).toBe(false);
    expect(info.tier3_card).toBeUndefined();

    const response = await sandbox.callTool(PIP_CALL);
    expect(resultText(response)).toContain(
      'Packages cannot be downloaded on this server, so this install was not run.',
    );
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });
});
