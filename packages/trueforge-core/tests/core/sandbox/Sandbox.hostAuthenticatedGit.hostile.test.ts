import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { buildHostAuthenticatedGit, planHostAuthenticatedGit } from '../../../src/core/sandbox/hostAuthenticatedGit';
import {
  commandWithWorkspaceLock,
  shellEscape,
  type ExecResult,
  type SandboxExecParams,
  type SandboxProvider,
} from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const execFileAsync = promisify(execFile);

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');
const GIT = '/usr/bin/git';
const HAS_TOOLS = ['/usr/bin/git', '/usr/bin/env', '/usr/bin/flock'].every(path => existsSync(path));
const describeWithTools = HAS_TOOLS ? describe : describe.skip;
const describeWithOpenssl = HAS_TOOLS && existsSync('/usr/bin/openssl') ? describe : describe.skip;

function initRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync(GIT, ['init', '-q'], { cwd: repo });
  return repo;
}

interface RealProviderInput {
  root: string;
  /** Model-writable directories a provider puts first on PATH (TFY mcp-client/bin, local .venv/bin). */
  writablePathDirs: readonly string[];
  /** Replaces the pinned git so a push does not need a network. */
  gitReplacement: string | undefined;
}

/** Runs commands in a real shell the way a provider does: lock wrapper first, then PATH re-prepended after env. */
function makeRealProvider(input: RealProviderInput): SandboxProvider {
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    const locked = commandWithWorkspaceLock(params);
    const command =
      input.gitReplacement === undefined
        ? locked.command
        : locked.command.replaceAll(shellEscape(GIT), shellEscape(input.gitReplacement));
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: locked.cwd ?? input.root,
      encoding: 'utf8',
      env: {
        ...locked.env,
        PATH: [...input.writablePathDirs, '/usr/bin', '/bin'].join(':'),
        HOME: input.root,
      },
    });
    return Promise.resolve({
      success: true,
      response: { exitCode: result.status ?? 1, result: `${result.stdout}${result.stderr}` },
    });
  };
  return {
    type: 'local',
    createSandbox: () => Promise.resolve({ sandboxId: input.root }),
    exec,
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
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(provider: SandboxProvider, root: string): Sandbox {
  return new Sandbox({
    provider,
    existingSandboxId: root,
    githubGitToken: TOKEN,
    githubConnectorAttached: true,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

async function run(input: {
  sandbox: Sandbox;
  command: string;
  cwd: string;
  purpose: 'edit' | 'push';
}): Promise<{ isError: boolean; text: string }> {
  const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
  const result = await input.sandbox.callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'git work', purpose: input.purpose, command: input.command, cwd: input.cwd },
    },
    approval,
  );
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result');
  }
  const content = result.result.content[0];
  return { isError: result.result.isError === true, text: content?.type === 'text' ? content.text : '' };
}

describeWithTools('hostile repository config and PATH never reach the token', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-auth-git-hostile-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function withCaptureServer<T>(
    use: (input: { port: number; connections: () => number }) => Promise<T>,
  ): Promise<T> {
    let connections = 0;
    const server = createServer(socket => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('capture server has no port');
    }
    try {
      return await use({ port: address.port, connections: () => connections });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  function poisonProxy(input: { repo: string; port: number }): void {
    execFileSync(GIT, ['config', 'http.proxy', `http://127.0.0.1:${String(input.port)}`], { cwd: input.repo });
    execFileSync(GIT, ['config', 'http.sslVerify', 'false'], { cwd: input.repo });
  }

  test('control: a poisoned http.proxy does capture an unguarded authenticated ls-remote', async () => {
    const repo = initRepo(root);
    await withCaptureServer(async ({ port, connections }) => {
      poisonProxy({ repo, port });
      const plan = planHostAuthenticatedGit({ command: 'git ls-remote https://github.com/o/r' });
      if (plan === undefined) {
        throw new Error('expected a plan');
      }
      const built = buildHostAuthenticatedGit({ plan, token: TOKEN, workspaceRoot: repo });
      await execFileAsync('/bin/sh', ['-c', built.command], {
        cwd: repo,
        env: { ...built.env, PATH: '/usr/bin:/bin' },
        timeout: 15_000,
      }).catch(() => undefined);
      expect(connections()).toBeGreaterThan(0);
    });
  });

  test('the same repository is refused before any git process can reach the proxy', async () => {
    const repo = initRepo(root);
    await withCaptureServer(async ({ port, connections }) => {
      poisonProxy({ repo, port });
      const sandbox = makeSandbox(makeRealProvider({ root, writablePathDirs: [], gitReplacement: undefined }), root);
      for (const command of ['git ls-remote https://github.com/o/r', 'git fetch https://github.com/o/r']) {
        const result = await run({ sandbox, command, cwd: repo, purpose: 'edit' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('did not authenticate');
      }
      expect(connections()).toBe(0);
    });
  });

  test('planted shims in model-writable PATH dirs never see the token', async () => {
    const repo = initRepo(root);
    const fakeGit = join(root, 'fake-git');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeGit, 0o755);
    const seen = join(root, 'shim-saw-token');
    const dirs = [join(root, 'mcp-client', 'bin'), join(root, '.venv', 'bin')];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      for (const name of [
        'git',
        'mkdir',
        'cat',
        'dirname',
        'sleep',
        'flock',
        'setsid',
        'sh',
        'env',
        'printf',
        'test',
      ]) {
        const real = ['/usr/bin', '/bin'].map(base => `${base}/${name}`).find(path => existsSync(path));
        if (real === undefined) {
          continue;
        }
        const shim = join(dir, name);
        writeFileSync(
          shim,
          `#!/bin/sh\n[ -n "$TRUEFORGE_GIT_TOKEN" ] && echo "${name}" >> ${shellEscape(seen)}\nexec ${real} "$@"\n`,
        );
        chmodSync(shim, 0o755);
      }
    }
    const provider = makeRealProvider({ root, writablePathDirs: dirs, gitReplacement: fakeGit });

    // The lock wrapper runs its helpers by fixed path, so a shim on the sandbox PATH never sees an env token.
    await provider.exec({
      sandboxId: root,
      command: 'true',
      cwd: repo,
      env: { TRUEFORGE_GIT_TOKEN: TOKEN },
      workspaceLock: { workspaceRoot: repo },
    });
    expect(existsSync(seen)).toBe(false);

    const sandbox = makeSandbox(provider, root);
    for (const command of [
      'git push origin main',
      'git fetch origin',
      'git pull --ff-only',
      'git ls-remote https://github.com/o/r',
    ]) {
      const result = await run({ sandbox, command, cwd: repo, purpose: command.includes('push') ? 'push' : 'edit' });
      expect(result.isError).toBe(false);
    }
    expect(existsSync(seen) ? readFileSync(seen, 'utf8') : '').toBe('');
  });
});

describeWithOpenssl('the hardened git config still completes a verified TLS handshake', () => {
  test('a CA bundle supplied only through GIT_SSL_CAINFO is honoured and the request reaches the server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-auth-git-tls-'));
    try {
      const openssl = (args: string[]): void => {
        execFileSync('/usr/bin/openssl', args, { cwd: root, stdio: 'ignore' });
      };
      openssl([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.crt',
        '-subj',
        '/CN=test-ca',
        '-days',
        '2',
      ]);
      openssl([
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'srv.key',
        '-out',
        'srv.csr',
        '-subj',
        '/CN=127.0.0.1',
      ]);
      writeFileSync(join(root, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
      openssl([
        'x509',
        '-req',
        '-in',
        'srv.csr',
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'srv.crt',
        '-days',
        '2',
        '-extfile',
        'ext.cnf',
      ]);

      let requests = 0;
      const server = createHttpsServer(
        { key: readFileSync(join(root, 'srv.key')), cert: readFileSync(join(root, 'srv.crt')) },
        (_request, response) => {
          requests += 1;
          response.statusCode = 404;
          response.end('not found');
        },
      );
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('tls server has no port');
      }
      try {
        const plan = planHostAuthenticatedGit({ command: 'git ls-remote https://github.com/o/r' });
        if (plan === undefined) {
          throw new Error('expected a plan');
        }
        const built = buildHostAuthenticatedGit({ plan, token: TOKEN, workspaceRoot: undefined });
        const command = built.command.replace(
          'https://github.com/o/r',
          `https://127.0.0.1:${String(address.port)}/o/r`,
        );
        const output = await execFileAsync('/bin/sh', ['-c', `${command} 2>&1`], {
          cwd: root,
          env: { ...built.env, GIT_SSL_CAINFO: join(root, 'ca.crt') },
          timeout: 20_000,
        }).then(
          result => result.stdout,
          (error: { stdout?: string }) => error.stdout ?? '',
        );
        // The empty-CA-config regression (which libcurl cannot satisfy) is pinned by the unit test;
        // here the CA arrives the way an image would supply it and must survive the env scrub.
        expect(output).not.toMatch(/SSL|certificate|CAfile/iu);
        expect(requests).toBeGreaterThan(0);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
