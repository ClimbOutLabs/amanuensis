import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import { toToolCallInfo } from '../../../src/core/runtime/contextUtils';
import {
  commandWithWorkspaceLock,
  type ExecResult,
  type SandboxExecParams,
  type SandboxProvider,
} from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');
const GIT = '/usr/bin/git';
const HAS_TOOLS = ['/usr/bin/git', '/usr/bin/env', '/usr/bin/flock', '/usr/bin/openssl'].every(path =>
  existsSync(path),
);
const describeWithTools = HAS_TOOLS ? describe : describe.skip;

function openssl(input: { root: string; args: string[] }): void {
  execFileSync('/usr/bin/openssl', input.args, { cwd: input.root, stdio: 'ignore' });
}

/** A test CA and a github.com leaf, so the stand-in for GitHub passes git's certificate check. */
function makeCerts(root: string): void {
  openssl({
    root,
    args: ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=t'],
  });
  openssl({
    root,
    args: ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=github.com'],
  });
  writeFileSync(join(root, 'ext.cnf'), 'subjectAltName=DNS:github.com\n');
  openssl({
    root,
    args: [
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
    ],
  });
}

interface SeenRequest {
  path: string;
  authorization: string | undefined;
}

/** A CONNECT proxy that answers as github.com, asks for credentials until it gets them, and records every request. */
async function fakeGithub(root: string): Promise<{ port: number; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const key = readFileSync(join(root, 'srv.key'));
  const cert = readFileSync(join(root, 'srv.crt'));
  const server = createServer((socket: Socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tls = new TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] });
      tls.on('error', () => undefined);
      let buffer = '';
      tls.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        for (let end = buffer.indexOf('\r\n\r\n'); end !== -1; end = buffer.indexOf('\r\n\r\n')) {
          const [requestLine, ...headers] = buffer.slice(0, end).split('\r\n');
          buffer = buffer.slice(end + 4);
          const authorization = headers.find(header => /^authorization:/iu.test(header))?.split(': ')[1];
          seen.push({ path: requestLine?.split(' ')[1] ?? '', authorization });
          tls.write(
            authorization === undefined
              ? 'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="GitHub"\r\nContent-Length: 2\r\n\r\nno'
              : 'HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno',
          );
        }
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake GitHub has no port');
  }
  return {
    port: address.port,
    seen,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Runs commands in a real shell, routing github.com through the fake and trusting its test CA. */
function makeProvider(input: { root: string; proxyPort: number }): SandboxProvider {
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    const locked = commandWithWorkspaceLock(params);
    return new Promise(resolve => {
      execFile(
        '/bin/sh',
        ['-c', locked.command],
        {
          cwd: locked.cwd ?? input.root,
          encoding: 'utf8',
          env: {
            ...locked.env,
            PATH: '/usr/bin:/bin',
            HOME: input.root,
            https_proxy: `http://127.0.0.1:${String(input.proxyPort)}`,
            GIT_SSL_CAINFO: join(input.root, 'ca.crt'),
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ success: true, response: { exitCode, result: `${stdout}${stderr}` } });
        },
      );
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

describeWithTools('the token reaches only the repository shown for approval', () => {
  test.each([
    ['a dot-segment repository widening the scope to all of github.com', ['https://github.com/victim/..']],
    [
      'a second address that fetch contacts while the card shows the last one',
      ['https://github.com/attacker/x', 'https://github.com/o/r'],
    ],
    [
      'a second address combined with a dot-segment one',
      ['https://github.com/someone-else/private', 'https://github.com/victim/..'],
    ],
    ['an owner-wide dot-segment address', ['https://github.com/victim/secret', 'https://github.com/victim/.']],
  ])(
    '%s',
    async (_name, urls) => {
      const root = mkdtempSync(join(tmpdir(), 'host-auth-git-scope-'));
      try {
        makeCerts(root);
        const repo = join(root, 'repo');
        mkdirSync(repo);
        execFileSync(GIT, ['init', '-q', '-b', 'main'], { cwd: repo });
        for (const url of urls) {
          execFileSync(GIT, ['config', '--add', 'remote.origin.url', url], { cwd: repo });
        }
        const github = await fakeGithub(root);
        try {
          const sandbox = new Sandbox({
            provider: makeProvider({ root, proxyPort: github.port }),
            existingSandboxId: root,
            githubGitToken: TOKEN,
            githubConnectorAttached: true,
            blockDestructiveToolsInCodeMode: true,
            mcpRequestTimeoutMs: 60_000,
            mcpConnectTimeoutMs: 5_000,
            logger: makeSilentLogger(),
            tracing: NOOP_AGENT_TRACING,
          });
          const call = {
            name: SANDBOX_EXEC_TOOL_NAME,
            arguments: { intent: 'sync', purpose: 'edit', command: 'git fetch origin', cwd: repo },
          };
          const shown = await sandbox.toolCallInfo(call);
          const approval: ApprovalDecision = { status: 'allow', scope: 'once' };
          await sandbox.callTool(call, approval, {
            admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
            ...(shown.git_remote_precondition === undefined
              ? {}
              : { git_remote_precondition: shown.git_remote_precondition }),
          });

          const shownPaths = (shown.git_remote_precondition?.remotes ?? []).map(remote => new URL(remote.url).pathname);
          const outsideShown = (request: SeenRequest): boolean =>
            !shownPaths.some(path => request.path === path || request.path.startsWith(`${path}/`));
          expect(github.seen.filter(request => request.authorization !== undefined && outsideShown(request))).toEqual(
            [],
          );
          // A card that names a repository must name the one git actually contacts.
          if (shownPaths.length > 0) {
            expect(toToolCallInfo(shown).host_observed_target_summary).toBeDefined();
            expect(github.seen.filter(outsideShown)).toEqual([]);
          }
        } finally {
          await github.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
