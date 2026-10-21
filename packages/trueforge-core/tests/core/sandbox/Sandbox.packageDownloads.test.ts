import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { RunCodeBackend } from '../../../src/core/sandbox/driver/RunCodeService';
import { PACKAGE_GIT_DEPENDENCY_MESSAGE } from '../../../src/core/sandbox/packageMirrors';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, type BoundRepository } from '../../../src/core/sandbox/Sandbox';
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

/** A run_code driver that can reach the package gateway, so an install can reach the approval card. */
const PACKAGE_GATEWAY_RUN_CODE_SERVICE: RunCodeBackend = {
  packageGatewayCapable: true,
  runCode: () => Promise.reject(new Error('run_code is not used in these tests')),
  scrubDispatchErrorText: text => text,
};

const PACKAGE_CARD_WHAT = "Aman wants to download this project's packages from the public package sites (PyPI).";

const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';

function makeProvider(execCalls: SandboxExecParams[], files?: Record<string, string>): SandboxProvider {
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec((params: SandboxExecParams): Promise<ExecResult> => {
      execCalls.push(params);
      const result =
        params.command === BOUND_REPOSITORY_STATE_COMMAND
          ? '/work\nmain\n0123456789abcdef\n'
          : params.command === 'git rev-parse --show-toplevel'
            ? '/work'
            : params.command === 'git rev-parse --abbrev-ref HEAD'
              ? 'main'
              : params.command === 'git rev-parse HEAD'
                ? '0123456789abcdef'
                : params.command === 'git rev-parse --absolute-git-dir'
                  ? '/work/.git'
                  : params.command.startsWith('ls -di -- .git ')
                    ? '11 .git\n12 /work/.git'
                    : '';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    }),
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
}): Sandbox {
  return new Sandbox({
    provider: makeProvider(input.execCalls, input.files),
    boundRepository: input.boundRepository,
    loadBoundRepository: input.boundRepository === undefined ? undefined : async () => input.boundRepository,
    workspaceVerificationCoordinator:
      input.boundRepository === undefined ? undefined : new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: input.boundRepository === undefined ? undefined : 'test-replica',
    loadPackageMirrorToken: async () => (input.allowed() ? 'mirror-token' : undefined),
    loadPackageDownloadsAllowed: async () => input.allowed(),
    allowPackageDownloads: input.allowPackageDownloads,
    runCodeService: PACKAGE_GATEWAY_RUN_CODE_SERVICE,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: '/work',
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    }),
  });
}

const PIP_CALL = {
  name: SANDBOX_EXEC_TOOL_NAME,
  arguments: { intent: 'Install the project packages', purpose: 'execute', command: 'pip install requests' },
};

describe('the first package download in a repo', () => {
  it('shows the download card wording while the repo has not allowed downloads', async () => {
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
      boundRepository: BOUND_REPOSITORY,
    });
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).toBe(PACKAGE_CARD_WHAT);
  });

  it('keeps the ordinary card wording once the repo allows downloads', async () => {
    const sandbox = makeSandbox({
      execCalls: [],
      allowed: () => true,
      allowPackageDownloads: async () => undefined,
      boundRepository: BOUND_REPOSITORY,
    });
    const info = await sandbox.toolCallInfo(PIP_CALL);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card?.plain_what).not.toContain('public package sites');
  });

  it.each([
    ['pip install requests', 'pip'],
    ['npm install left-pad', 'npm'],
  ])('refuses %s before any card when no repository is bound, and never runs it', async (command, label) => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads: async () => undefined,
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
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected a text tool result');
    expect(content.text).toContain('Packages cannot be downloaded in this chat, so this install was not run.');
    expect(content.text).toContain('open this work on a repository that allows downloads');
    expect(execCalls.some(params => params.command === command)).toBe(false);
  });

  it('is refused with the card while unapproved: nothing runs and nothing is recorded', async () => {
    const execCalls: SandboxExecParams[] = [];
    const allowPackageDownloads = jest.fn(async () => undefined);
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads,
      boundRepository: BOUND_REPOSITORY,
    });
    const response = await sandbox.callTool(PIP_CALL);
    if (!('approvalRequired' in response)) {
      throw new Error('Expected the call to wait for approval');
    }
    expect(response.approvalRequired.tool_info.tier3_card?.plain_what).toBe(PACKAGE_CARD_WHAT);
    expect(allowPackageDownloads).not.toHaveBeenCalled();
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });

  it('records the allowance on approval, and the approved command itself runs with the mirror token', async () => {
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
    });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    expect(allowPackageDownloads).toHaveBeenCalledTimes(1);
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(false);
    const pipExec = execCalls.find(params => params.command === 'pip install requests');
    expect(pipExec?.packageMirrorToken).toBe('mirror-token');
  });

  it('does not record the allowance again when the repo already allows downloads', async () => {
    const execCalls: SandboxExecParams[] = [];
    const allowPackageDownloads = jest.fn(async () => undefined);
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => true,
      allowPackageDownloads,
      boundRepository: BOUND_REPOSITORY,
    });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(false);
    expect(allowPackageDownloads).not.toHaveBeenCalled();
    const pipExec = execCalls.find(params => params.command === 'pip install requests');
    expect(pipExec?.packageMirrorToken).toBe('mirror-token');
  });

  it('refuses the approved command with the reason when the allowance cannot be saved', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads: async () => {
        throw new Error('store unavailable');
      },
      boundRepository: BOUND_REPOSITORY,
    });
    const response = await sandbox.callTool(PIP_CALL, { status: 'allow' });
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(response.result.isError).toBe(true);
    const content = response.result.content[0];
    if (content?.type !== 'text') {
      throw new Error('Expected a text tool result');
    }
    expect(content.text).toContain('Aman could not save the download setting for this repo. Try again.');
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });

  it('never records the allowance for an approved command that downloads nothing', async () => {
    const execCalls: SandboxExecParams[] = [];
    const allowPackageDownloads = jest.fn(async () => undefined);
    const sandbox = makeSandbox({
      execCalls,
      allowed: () => false,
      allowPackageDownloads,
      boundRepository: BOUND_REPOSITORY,
    });
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Look at the files', purpose: 'execute', command: 'ls -la' },
      },
      { status: 'allow' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    expect(allowPackageDownloads).not.toHaveBeenCalled();
  });
});

describe('a package the mirrors cannot serve', () => {
  async function runCommand(input: {
    execCalls: SandboxExecParams[];
    command: string;
    files?: Record<string, string> | undefined;
  }) {
    const sandbox = makeSandbox({
      execCalls: input.execCalls,
      allowed: () => true,
      allowPackageDownloads: async () => undefined,
      boundRepository: BOUND_REPOSITORY,
      ...(input.files === undefined ? {} : { files: input.files }),
    });
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Install a package', purpose: 'execute', command: input.command },
      },
      { status: 'allow' },
    );
    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a tool result');
    }
    return response.result;
  }

  function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
    const content = result.content[0];
    if (content?.type !== 'text' || content.text === undefined) {
      throw new Error('Expected a text tool result');
    }
    return content.text;
  }

  it.each([
    ['a git spec on the command line', 'pip install git+https://github.com/org/repo'],
    [
      'an editable git spec in equals form on the command line',
      'pip install --editable=git+https://github.com/org/repo',
    ],
    ['a shorthand on the command line', 'npm i github:org/repo'],
    ['a web address on the command line', 'pip install https://files.pythonhosted.org/pkg-1.0.tar.gz'],
  ])('refuses %s before anything runs', async (_name, command) => {
    const execCalls: SandboxExecParams[] = [];
    const result = await runCommand({ execCalls, command });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(PACKAGE_GIT_DEPENDENCY_MESSAGE);
    expect(execCalls.some(params => params.command === command)).toBe(false);
  });

  it('refuses a git dependency named in the project manifest', async () => {
    const execCalls: SandboxExecParams[] = [];
    const result = await runCommand({
      execCalls,
      command: 'pip install requests',
      files: {
        '/work/package.json': JSON.stringify({ dependencies: { lib: 'github:org/repo' } }),
      },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(PACKAGE_GIT_DEPENDENCY_MESSAGE);
    expect(execCalls.some(params => params.command === 'pip install requests')).toBe(false);
  });

  it('runs a command whose package argument is a local path', async () => {
    const execCalls: SandboxExecParams[] = [];
    const result = await runCommand({ execCalls, command: 'pip install ./lib' });
    expect(result.isError).toBe(false);
    const pipExec = execCalls.find(params => params.command === 'pip install ./lib');
    expect(pipExec?.packageMirrorToken).toBe('mirror-token');
  });
});
