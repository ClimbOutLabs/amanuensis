import { createSentinelHostContext, defaultSentinelServices } from '../../../../src/core/permissions/context';
import type {
  ExecResult,
  HostGitCapability,
  HostGitPushPreviewResult,
  SandboxExecParams,
  SandboxProvider,
} from '../../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';

const TOKEN = 'fake-host-token-that-must-stay-on-the-host';

function previewOk(): HostGitPushPreviewResult {
  return {
    status: 'ok',
    preview: {
      repository: 'acme/widgets',
      remote_name: 'origin',
      remote_url: 'https://github.com/acme/widgets.git',
      source_branch: 'main',
      branch: 'main',
      tip: 'a'.repeat(40),
      base: 'b'.repeat(40),
      commit_count: 2,
      commits: [
        { sha: 'c'.repeat(40), subject: 'second change' },
        { sha: 'd'.repeat(40), subject: 'first change' },
      ],
      dry_run: false,
      set_upstream: false,
    },
  };
}

function setup(preview: HostGitPushPreviewResult = previewOk()) {
  const execCalls: SandboxExecParams[] = [];
  const setToken = jest.fn<void, [string | null]>();
  const previewPush = jest.fn(async (_input: Parameters<HostGitCapability['previewPush']>[0]) => preview);
  const hostGit: HostGitCapability = {
    setToken,
    isPush: command => /^git push\b/u.test(command),
    previewPush,
  };
  const provider: SandboxProvider = {
    type: 'slots',
    hostGit,
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 's1-' + 'e'.repeat(32) }),
    exec: (params): Promise<ExecResult> => {
      execCalls.push(params);
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'done' } });
    },
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'unused' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => '/workspace',
    getToolResultDumpDir: () => '/workspace/.aman/tool-results',
    getGitCredentialsPath: () => '/workspace/.aman/.git-credentials',
    getFileUploadsDir: () => '/workspace/.aman/uploads',
    getSkillsDir: () => '/workspace/.aman/skills',
    getSkillDownloaderPath: () => '/workspace/.aman/skill_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
  const sandbox = new Sandbox({
    provider,
    githubGitToken: TOKEN,
    githubConnectorAttached: true,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: '/workspace',
      services: defaultSentinelServices({ pinned_path: '/usr/bin' }),
    }),
  });
  return { sandbox, execCalls, setToken, previewPush };
}

const pushArguments = (command: string) => ({
  intent: 'Publish the work',
  purpose: 'push',
  command,
  cwd: '/workspace/widgets',
});

describe('a Sandbox whose provider does network git on the host', () => {
  test('hands the GitHub token to the provider and keeps it out of every sandbox command', async () => {
    const { sandbox, execCalls, setToken } = setup();
    expect(setToken).toHaveBeenCalledWith(TOKEN);

    await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { ...pushArguments('git clone https://github.com/acme/widgets'), purpose: 'execute' },
      },
      { status: 'allow', scope: 'once' },
    );
    const clone = execCalls.find(call => call.command.includes('git clone'));
    expect(clone?.command).toBe('git clone https://github.com/acme/widgets');
    for (const call of execCalls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
      expect(call.env?.['TRUEFORGE_GIT_TOKEN']).toBeUndefined();
    }
  });

  test('a push card names the repository, branch and commits the host worked out', async () => {
    const { sandbox, previewPush } = setup();
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: pushArguments('git push origin main'),
    });

    expect(previewPush).toHaveBeenCalledTimes(1);
    expect(info.is_approval_required).toBe(true);
    expect(info.tier3_card).toMatchObject({
      plain_what: 'Push 2 commits to the main branch of acme/widgets on GitHub.',
      destination: 'github.com/acme/widgets (branch main)',
      cannot_be_undone: "Once this is sent, it can't be unsent.",
    });
    expect(info.tier3_card?.parsed_command).toContain('git push origin main');
    expect(info.tier3_card?.parsed_command).toContain('ccccccc second change');
    expect(info.tier3_card?.parsed_command).toContain('ddddddd first change');
  });

  test('keeps the rest of the Sentinel card (why, re-ask) unchanged', async () => {
    const { sandbox } = setup();
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: pushArguments('git push origin main'),
    });
    expect(info.tier3_card?.plain_why).toBeDefined();
    expect(info.tier).toBe(3);
  });

  test('a push the host will not carry out is refused before any approval card', async () => {
    const { sandbox } = setup({ status: 'refused', message: 'fatal: --force is not available from the sandbox.' });
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: pushArguments('git push --force origin main'),
    });
    expect(info.is_approval_required).toBe(false);
    expect(info.pre_dispatch_failure).toEqual({
      kind: 'policy_blocked',
      message: 'fatal: --force is not available from the sandbox.',
    });
  });

  test('commands that are not a push are not previewed', async () => {
    const { sandbox, previewPush } = setup();
    await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { ...pushArguments('ls'), purpose: 'inspect' },
    });
    expect(previewPush).not.toHaveBeenCalled();
  });
});
