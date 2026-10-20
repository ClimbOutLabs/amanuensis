import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolInvocationContext } from '../../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult } from '../../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../../src/core/permissions/context';
import { toToolCallInfo } from '../../../../src/core/runtime/contextUtils';
import { pickGitNetworkEnv } from '../../../../src/core/sandbox/hostAuthenticatedGit';
import {
  type BoundRepository,
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
} from '../../../../src/core/sandbox/Sandbox';
import { GitBridge } from '../../../../src/core/sandbox/slots/git/gitBridge';
import { execFileRunner } from '../../../../src/core/sandbox/slots/git/hostCommand';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';
import { TestDurableWorkspaceCoordinator } from '../durableWorkspaceCoordinator';
import { fakeGithub, makeCerts, type SeenRequest } from '../fakeGithub';
import { attestation, FakeAgent, type FakeHandler } from './fakeAgent';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['FAKE', 'slot', 'token', 'not', 'real'].join('-');
const GIT = '/usr/bin/git';
const HAS_TOOLS = [GIT, '/usr/bin/env', '/usr/bin/openssl'].every(path => existsSync(path));
const describeWithTools = HAS_TOOLS ? describe : describe.skip;
const SANDBOX_ID = `s1-${'e'.repeat(32)}`;
const SHOWN = 'https://github.com/acme/widgets';
const OTHER = 'https://github.com/other/private';
const GUEST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => (typeof entry === 'string' ? [[key, entry]] : [])),
  );
}

/** A slot agent stand-in that runs each guest command for real, offline, in `workspace` standing in for /workspace. */
function guestAgent(workspace: string): FakeHandler {
  const map = (text: string): string => text.split('/workspace').join(workspace);
  return request => {
    const body = stringRecord(request.body);
    const raw = request.body !== null && typeof request.body === 'object' ? request.body : {};
    if (request.path === '/v1/health') {
      return { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } };
    }
    if (request.path === '/v1/exec') {
      const argv = Reflect.get(raw, 'argv');
      const list = Array.isArray(argv) ? argv.map(String) : [];
      const cwd = map(body['cwd'] ?? '/workspace');
      mkdirSync(cwd, { recursive: true });
      const env = Object.fromEntries(
        Object.entries(stringRecord(Reflect.get(raw, 'env'))).map(([key, value]) => [key, map(value)]),
      );
      const run = spawnSync(list[0] ?? 'false', list.slice(1).map(map), {
        cwd,
        env: { ...GUEST_ENV, ...env },
        encoding: 'utf8',
      });
      return {
        status: 200,
        body: {
          exit_code: run.status ?? 1,
          output: `${run.stdout}${run.stderr}`,
          terminated_by: 'completed',
          internal_error: '',
          notices: [],
          duration_ms: 1,
        },
      };
    }
    if (request.path === '/v1/fs_write') {
      const target = map(body['path'] ?? '');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(body['content_base64'] ?? '', 'base64'));
      return { status: 204, body: undefined };
    }
    if (request.path === '/v1/fs_read') {
      const content = readFileSync(map(body['path'] ?? ''));
      return { status: 200, body: { content_base64: content.toString('base64'), size_bytes: content.byteLength } };
    }
    return { status: 404, body: { error: { code: 'not_found', message: request.path } } };
  };
}

function resultText(result: Awaited<ReturnType<Sandbox['callTool']>>): string {
  const content = isCallToolResponseResult(result) ? result.result.content[0] : undefined;
  return content?.type === 'text' ? content.text : '';
}

describeWithTools('fetch and pull on sandbox slots offer the token only to the repository shown for approval', () => {
  let root: string;
  let checkout: string;
  let github: Awaited<ReturnType<typeof fakeGithub>>;
  let agent: FakeAgent;
  let socket: string;

  const guestGit = (...args: string[]): void => {
    execFileSync(GIT, args, { cwd: checkout, env: GUEST_ENV });
  };
  const authorized = (): SeenRequest[] => github.seen.filter(request => request.authorization !== undefined);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'slot-host-fetch-'));
    const workspace = join(root, 'workspace');
    checkout = join(workspace, 'widgets');
    mkdirSync(checkout, { recursive: true });
    makeCerts(root);
    guestGit('init', '-q', '-b', 'main');
    guestGit('remote', 'add', 'origin', SHOWN);
    github = await fakeGithub(root);
    agent = new FakeAgent(guestAgent(workspace));
    socket = await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
    await github.close();
    rmSync(root, { recursive: true, force: true });
  });

  function makeProvider(): SlotSandboxProvider {
    return new SlotSandboxProvider({
      socketPaths: [socket],
      defaultExecTimeoutSeconds: 60,
      treeDiskMb: 2048,
      fileMaxBytesForDownload: 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: () => Promise.resolve(),
      gitBridge: new GitBridge({
        scratchRoot: join(root, 'scratch'),
        runner: execFileRunner,
        logger: makeSilentLogger(),
        remoteUrl: undefined,
        networkEntries: undefined,
        networkEnv: pickGitNetworkEnv({
          https_proxy: `http://127.0.0.1:${String(github.port)}`,
          GIT_SSL_CAINFO: join(root, 'ca.crt'),
        }),
        scratchCapBytes: undefined,
        now: undefined,
      }),
    });
  }

  function makeSandbox(boundRepository?: BoundRepository): Sandbox {
    return new Sandbox({
      provider: makeProvider(),
      existingSandboxId: SANDBOX_ID,
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
      ...(boundRepository === undefined
        ? {}
        : {
            boundRepository,
            loadBoundRepository: () => Promise.resolve(boundRepository),
            workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
            workspaceLeaseOwnerId: 'test-replica',
          }),
    });
  }

  const execCall = (command: string) => ({
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: { intent: 'Sync with upstream', purpose: 'edit', command, cwd: '/workspace/widgets' },
  });

  async function approveShown(
    sandbox: Sandbox,
    call: ReturnType<typeof execCall>,
  ): Promise<{ shown: Awaited<ReturnType<Sandbox['toolCallInfo']>>; context: ToolInvocationContext }> {
    const shown = await sandbox.toolCallInfo(call);
    return {
      shown,
      context: {
        admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
        ...(shown.git_remote_precondition === undefined
          ? {}
          : { git_remote_precondition: shown.git_remote_precondition }),
      },
    };
  }

  test('the card names the repository origin points at, and only that repository is offered the token', async () => {
    guestGit('remote', 'set-url', 'origin', OTHER);
    const sandbox = makeSandbox();
    const call = execCall('git fetch origin');
    const { shown, context } = await approveShown(sandbox, call);

    expect(shown.git_remote_precondition?.remotes).toEqual([{ name: 'origin', url: `${OTHER}.git` }]);
    expect(toToolCallInfo(shown).host_observed_target_summary).toContain(`origin, which is ${OTHER}.git`);

    await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);
    expect(authorized().length).toBeGreaterThan(0);
    expect(authorized().every(request => request.path.startsWith('/other/private.git/'))).toBe(true);
  }, 60_000);

  test.each([
    ['a named remote', 'git fetch origin'],
    ['the default remote of a bare pull', 'git pull'],
  ])(
    '%s repointed after the card is refused and sends no credentials',
    async (_name, command) => {
      const sandbox = makeSandbox();
      const call = execCall(command);
      const { shown, context } = await approveShown(sandbox, call);
      expect(shown.git_remote_precondition?.remotes).toEqual([{ name: 'origin', url: `${SHOWN}.git` }]);

      guestGit('remote', 'set-url', 'origin', OTHER);
      const result = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

      expect(resultText(result)).toContain('not the one shown for approval');
      expect(authorized()).toEqual([]);
    },
    60_000,
  );

  test('a fetch with no approved repository is refused and sends no credentials', async () => {
    guestGit('remote', 'set-url', 'origin', OTHER);
    const sandbox = makeSandbox();

    const result = await sandbox.callTool(execCall('git fetch origin'), { status: 'allow', scope: 'once' });

    expect(resultText(result)).toContain('No repository was shown for approval');
    expect(authorized()).toEqual([]);
  }, 60_000);

  test('a network git command that reaches the provider without an approved repository offers no token', async () => {
    const provider = makeProvider();
    provider.hostGit?.setToken(TOKEN);

    const result = await provider.exec({ sandboxId: SANDBOX_ID, command: 'git fetch origin', cwd: 'widgets' });

    expect(result.success && result.response.result).toContain('No repository was shown for approval');
    expect(authorized()).toEqual([]);
  }, 60_000);

  // Registered commands run as verification, which also refuses a fetch before it reaches the provider.
  test('a registered git fetch never reaches GitHub with the token', async () => {
    guestGit('commit', '-q', '--allow-empty', '-m', 'seed');
    guestGit('remote', 'set-url', 'origin', OTHER);
    const sandbox = makeSandbox({
      repository_id: 'repo-1',
      revision: 1,
      workspace_cwd: '/workspace/widgets',
      commands: [{ command_id: 'sync', purpose: 'verify', command: 'git fetch origin', timeout_ms: 60_000 }],
    });

    const result = await sandbox.callTool(
      {
        name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
        arguments: { intent: 'Sync with upstream', command_id: 'sync' },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(result) && result.result.isError).toBe(true);
    expect(authorized()).toEqual([]);
  }, 60_000);
});
