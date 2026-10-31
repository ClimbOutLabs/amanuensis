import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import type { Logger } from 'winston';
import winston from 'winston';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import {
  withTrustedPath,
  type ExecResult,
  type SandboxExecParams,
  type SandboxProvider,
} from '../../../src/core/sandbox/provider/Provider';
import {
  Sandbox,
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  type BoundRepository,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

interface Fixture {
  root: string;
  repo: string;
  marker: string;
  script: string;
  pinnedDir: string;
  cleanup: () => void;
}

function repoFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-capture-')));
  const repo = join(root, 'repo');
  const marker = join(root, 'marker');
  const script = join(root, 'payload.sh');
  mkdirSync(repo);
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
  chmodSync(script, 0o755);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  git(repo, ['add', 'f.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'f.txt'), 'two\n');
  const pinnedDir = join(root, 'bin');
  mkdirSync(pinnedDir);
  for (const program of ['git', 'ls', 'mkdir', 'rm']) {
    const resolved = execFileSync('sh', ['-c', `command -v ${program}`], { encoding: 'utf8' }).trim();
    symlinkSync(resolved, join(pinnedDir, program));
  }
  return { root, repo, marker, script, pinnedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TRUSTED_PATH_PREFIX = withTrustedPath('');

function realProvider(
  fixture: Fixture,
  seen: SandboxExecParams[],
  paths: { shellPath?: string; trustedPath?: string; stripRefsFlag?: boolean } = {},
): SandboxProvider {
  const { shellPath, trustedPath } = paths;
  const exec = (params: SandboxExecParams): Promise<ExecResult> => {
    seen.push(params);
    // Stands in for a host whose fixed system PATH directories hold a different set of programs.
    const command =
      trustedPath === undefined
        ? params.command
        : params.command.replace(TRUSTED_PATH_PREFIX, `PATH='${trustedPath}'; export PATH; `);
    try {
      // Older git binaries (before 2.48) lack --include-root-refs; unless a test asks for
      // the real binary's answer, the flag is stripped: the ref list is not under test here.
      const runnable = paths.stripRefsFlag === false ? command : command.replace(' --include-root-refs', '');
      const out = execFileSync('sh', ['-c', runnable], {
        cwd: params.cwd ?? fixture.repo,
        env: { ...process.env, ...(shellPath === undefined ? {} : { PATH: shellPath }), ...params.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return Promise.resolve({ success: true, response: { exitCode: 0, result: out } });
    } catch (error) {
      return Promise.resolve({ success: true, response: { exitCode: 1, result: String(error) } });
    }
  };
  return {
    type: 'local',
    createSandbox: () => Promise.resolve({ sandboxId: join(fixture.root, 'sandbox') }),
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
    uploadFile: params => {
      mkdirSync(dirname(params.remotePath), { recursive: true });
      writeFileSync(params.remotePath, params.content);
      return Promise.resolve();
    },
    createCodeModeTransport: jest.fn(),
  };
}

function boundSandbox(fixture: Fixture, provider: SandboxProvider, logger?: Logger | undefined): Sandbox {
  const bound: BoundRepository = { repository_id: 'repo-1', revision: 1, workspace_cwd: fixture.repo, commands: [] };
  return new Sandbox({
    provider,
    boundRepository: bound,
    loadBoundRepository: () => Promise.resolve(bound),
    workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
    workspaceLeaseOwnerId: 'test-replica',
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: logger ?? makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: fixture.repo,
      services: defaultSentinelServices({ pinned_path: fixture.pinnedDir }),
    }),
  });
}

async function run(input: {
  sandbox: Sandbox;
  fixture: Fixture;
  command: string;
  purpose: 'inspect' | 'verify' | 'execute';
  approved?: boolean;
}) {
  const result = await input.sandbox.callTool(
    {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'check the tree',
        purpose: input.purpose,
        command: input.command,
        cwd: input.fixture.repo,
      },
    },
    input.approved === true ? { status: 'allow', scope: 'once' } : undefined,
  );
  return toolText(result);
}

function toolText(result: Awaited<ReturnType<Sandbox['callTool']>>): { isError: boolean; text: string } {
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result, not an approval request');
  }
  const content = result.result.content[0];
  return { isError: result.result.isError === true, text: content?.type === 'text' ? content.text : '' };
}

async function writeNewFile(input: { sandbox: Sandbox; fixture: Fixture; path: string; content: string }) {
  return toolText(
    await input.sandbox.callTool(
      {
        name: SANDBOX_WRITE_FILE_TOOL_NAME,
        arguments: { intent: 'add a file', cwd: input.fixture.repo, path: input.path, content: input.content },
      },
      { status: 'allow', scope: 'once' },
    ),
  );
}

const CHANGED_STATE = 'changed Git-visible repository state';

/** A project check outside the repository that, as a side effect, changes the checkout. */
function projectCheck(input: { fixture: Fixture; name: string; body: string }): string {
  const path = join(input.fixture.root, input.name);
  writeFileSync(path, `#!/bin/sh\n${input.body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const PROGRAM_CONFIGS: { name: string; setup: (fixture: Fixture) => void }[] = [
  { name: 'core.fsmonitor', setup: f => git(f.repo, ['config', 'core.fsmonitor', f.script]) },
  {
    name: 'a clean filter',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=x\n');
      git(f.repo, ['config', 'filter.x.clean', f.script]);
    },
  },
];

describe('verification state capture in a bound repository', () => {
  test.each(PROGRAM_CONFIGS)('purpose verify never runs a program named by $name', async ({ setup }) => {
    const fixture = repoFixture();
    try {
      setup(fixture);
      rmSync(fixture.marker, { force: true });
      const seen: SandboxExecParams[] = [];
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, seen)),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(existsSync(fixture.marker)).toBe(false);
      expect(result.isError).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('every git call the capture makes runs hardened on the trusted PATH and never diffs the worktree', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, seen)),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(result.isError).toBe(false);
      const captureReads = seen.filter(params => params.command.includes('git ls-files'));
      expect(captureReads.length).toBeGreaterThan(0);
      for (const params of captureReads) {
        expect(params.command.startsWith(TRUSTED_PATH_PREFIX)).toBe(true);
        expect(params.env).toMatchObject({
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_KEY_1: 'core.fsmonitor',
          GIT_CONFIG_VALUE_1: 'false',
        });
      }
      expect(seen.some(params => /\bgit diff\b/u.test(params.command))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('everyday local git settings do not block verify, execute or write_file, and changes are still caught', async () => {
    const fixture = repoFixture();
    try {
      git(fixture.repo, ['config', 'core.hooksPath', '.husky']);
      git(fixture.repo, ['config', 'gc.auto', '0']);
      git(fixture.repo, ['config', 'remote.origin.gh-resolved', 'base']);
      git(fixture.repo, ['config', 'branch.main.vscode-merge-base', 'origin/main']);
      const sandbox = boundSandbox(fixture, realProvider(fixture, []));

      const clean = await run({ sandbox, fixture, command: 'test -f f.txt', purpose: 'verify', approved: true });
      expect(clean).toMatchObject({ isError: false });
      const executed = await run({ sandbox, fixture, command: 'true', purpose: 'execute', approved: true });
      expect(executed).toMatchObject({ isError: false });
      const written = await writeNewFile({ sandbox, fixture, path: 'added-by-tool.txt', content: 'new\n' });
      expect(written.isError).toBe(false);
      expect(readFileSync(join(fixture.repo, 'added-by-tool.txt'), 'utf8')).toBe('new\n');

      const tracked = await run({
        sandbox,
        fixture,
        command: projectCheck({ fixture, name: 'check-tracked', body: ': > f.txt' }),
        purpose: 'verify',
        approved: true,
      });
      expect(tracked.isError).toBe(true);
      expect(tracked.text).toContain(CHANGED_STATE);
      const untracked = await run({
        sandbox,
        fixture,
        command: projectCheck({ fixture, name: 'check-untracked', body: ': > untracked.txt' }),
        purpose: 'verify',
        approved: true,
      });
      expect(untracked.isError).toBe(true);
      expect(untracked.text).toContain(CHANGED_STATE);
    } finally {
      fixture.cleanup();
    }
  });

  test('a configured clean filter is never run by the capture and does not refuse the call', async () => {
    const fixture = repoFixture();
    try {
      PROGRAM_CONFIGS[1]?.setup(fixture);
      git(fixture.repo, ['add', '.gitattributes']);
      rmSync(fixture.marker, { force: true });
      const sandbox = boundSandbox(fixture, realProvider(fixture, []));

      const clean = await run({ sandbox, fixture, command: 'test -f f.txt', purpose: 'verify', approved: true });
      expect(clean).toMatchObject({ isError: false });
      const changed = await run({
        sandbox,
        fixture,
        command: projectCheck({ fixture, name: 'check-tracked', body: ': > f.txt' }),
        purpose: 'verify',
        approved: true,
      });
      expect(changed.text).toContain(CHANGED_STATE);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('tracked names that differ only in undecodable bytes fail closed instead of hiding an edit', async () => {
    const fixture = repoFixture();
    try {
      execFileSync('sh', ['-c', `printf 1 > "$(printf 'x\\376')" && printf 1 > "$(printf 'x\\377')" && git add -A`], {
        cwd: fixture.repo,
      });
      git(fixture.repo, ['commit', '-q', '-m', 'two']);
      const sandbox = boundSandbox(fixture, realProvider(fixture, []));

      const result = await run({
        sandbox,
        fixture,
        command: projectCheck({ fixture, name: 'check-undecodable', body: `printf CHANGED > "$(printf 'x\\376')"` }),
        purpose: 'verify',
        approved: true,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Could not capture the Git repository state');
    } finally {
      fixture.cleanup();
    }
  });

  test('an approved apply_patch never runs a filter program the repository config defines', async () => {
    const fixture = repoFixture();
    try {
      git(fixture.repo, ['checkout', '--', 'f.txt']);
      writeFileSync(join(fixture.repo, '.gitattributes'), '* filter=evil\n');
      git(fixture.repo, ['add', '.gitattributes']);
      git(fixture.repo, ['commit', '-q', '-m', 'attributes']);
      git(fixture.repo, ['config', 'filter.evil.clean', fixture.script]);
      git(fixture.repo, ['config', 'filter.evil.smudge', fixture.script]);
      git(fixture.repo, ['config', 'filter.evil.required', 'true']);
      rmSync(fixture.marker, { force: true });
      const sandbox = boundSandbox(fixture, realProvider(fixture, []));
      const call = {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: {
          intent: 'change the file',
          cwd: fixture.repo,
          patch_lines: [
            'diff --git a/f.txt b/f.txt',
            '--- a/f.txt',
            '+++ b/f.txt',
            '@@ -1 +1 @@',
            '-one',
            '+patched',
            '',
          ],
        },
      };
      const info = await sandbox.toolCallInfo(call, true);
      const result = toolText(
        await sandbox.callTool(
          call,
          { status: 'allow', scope: 'once' },
          {
            admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
            ...(info.structured_edit_precondition === undefined
              ? {}
              : { structured_edit_precondition: info.structured_edit_precondition }),
          },
        ),
      );
      expect(result.isError).toBe(false);
      expect(readFileSync(join(fixture.repo, 'f.txt'), 'utf8')).toBe('patched\n');
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('host bookkeeping finds python3 in any trusted PATH directory', async () => {
    const fixture = repoFixture();
    try {
      // A host whose usable python3 lives only in a /usr/local/bin-style directory.
      const localBin = join(fixture.root, 'local-bin');
      const systemBin = join(fixture.root, 'system-bin');
      mkdirSync(localBin);
      mkdirSync(systemBin);
      const realPython = realpathSync(execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim());
      writeFileSync(
        join(localBin, 'python3'),
        `#!/bin/sh\necho python3 >> '${fixture.marker}'\nexec '${realPython}' "$@"\n`,
      );
      chmodSync(join(localBin, 'python3'), 0o755);
      for (const dir of ['/usr/bin', '/bin']) {
        for (const name of readdirSync(dir)) {
          if (!name.startsWith('python') && !existsSync(join(systemBin, name))) {
            symlinkSync(join(dir, name), join(systemBin, name));
          }
        }
      }
      const sandbox = boundSandbox(fixture, realProvider(fixture, [], { trustedPath: `${localBin}:${systemBin}` }));

      const written = await writeNewFile({ sandbox, fixture, path: 'from-local-python.txt', content: 'ok\n' });
      expect(written.isError).toBe(false);
      expect(readFileSync(join(fixture.repo, 'from-local-python.txt'), 'utf8')).toBe('ok\n');
      expect(readFileSync(fixture.marker, 'utf8')).toContain('python3');
    } finally {
      fixture.cleanup();
    }
  });

  test('purpose inspect is unaffected by the capture guard', async () => {
    const fixture = repoFixture();
    try {
      const result = await run({
        sandbox: boundSandbox(fixture, realProvider(fixture, [])),
        fixture,
        command: 'git status',
        purpose: 'inspect',
      });
      expect(result.isError).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('host bookkeeping never runs a program planted on the sandbox PATH', async () => {
    const fixture = repoFixture();
    try {
      const planted = join(fixture.root, 'planted');
      mkdirSync(planted);
      for (const program of ['git', 'mkdir', 'rm', 'realpath', 'python3']) {
        writeFileSync(join(planted, program), `#!/bin/sh\necho "${program}" >> '${fixture.marker}'\nexit 1\n`);
        chmodSync(join(planted, program), 0o755);
      }
      const result = await run({
        sandbox: boundSandbox(
          fixture,
          realProvider(fixture, [], { shellPath: `${planted}:${process.env['PATH'] ?? ''}` }),
        ),
        fixture,
        command: 'git status',
        purpose: 'verify',
      });
      expect(existsSync(fixture.marker)).toBe(false);
      expect(result.isError).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

interface CapturedLogLine {
  level: unknown;
  message: unknown;
  repositoryId: unknown;
  workspaceRoot: unknown;
  read: unknown;
  cwd: unknown;
  exitCode: unknown;
  error: unknown;
}

function captureLine(line: string): CapturedLogLine {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('A captured log line was not a JSON object');
  }
  return {
    level: Reflect.get(parsed, 'level'),
    message: Reflect.get(parsed, 'message'),
    repositoryId: Reflect.get(parsed, 'repositoryId'),
    workspaceRoot: Reflect.get(parsed, 'workspaceRoot'),
    read: Reflect.get(parsed, 'read'),
    cwd: Reflect.get(parsed, 'cwd'),
    exitCode: Reflect.get(parsed, 'exitCode'),
    error: Reflect.get(parsed, 'error'),
  };
}

/** A real winston logger writing JSON lines a test can read back. */
function makeCapturingLogger(): { logger: Logger; lines: () => CapturedLogLine[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = winston.createLogger({
    level: 'warn',
    format: winston.format.json(),
    transports: [new winston.transports.Stream({ stream })],
  });
  logger.child = () => logger;
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(captureLine),
  };
}

/**
 * A provider whose first capture read (the repository root lookup) fails the way git
 * does. Only the capture's own read is failed: it is the one carrying the hardened git
 * environment; the lease's earlier root lookup runs without it and still succeeds.
 */
function failingToplevelProvider(fixture: Fixture, seen: SandboxExecParams[], errorOutput: string): SandboxProvider {
  const base = realProvider(fixture, seen);
  return {
    ...base,
    exec: (params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === `${TRUSTED_PATH_PREFIX}git rev-parse --show-toplevel` && params.env !== undefined) {
        seen.push(params);
        return Promise.resolve({ success: true, response: { exitCode: 128, result: errorOutput } });
      }
      return base.exec(params);
    },
  };
}

/** A provider whose refs read always fails with the given output; every other call runs for real. */
function failingRefsProvider(fixture: Fixture, seen: SandboxExecParams[], errorOutput: string): SandboxProvider {
  const base = realProvider(fixture, seen);
  return {
    ...base,
    exec: (params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes('for-each-ref')) {
        seen.push(params);
        return Promise.resolve({ success: true, response: { exitCode: 129, result: errorOutput } });
      }
      return base.exec(params);
    },
  };
}

function refsCommands(seen: SandboxExecParams[]): string[] {
  return seen.map(params => params.command).filter(command => command.includes('for-each-ref'));
}

/** Whether the git on this machine knows --include-root-refs (it arrived in git 2.48). */
function localGitAcceptsRootRefsFlag(cwd: string): boolean {
  try {
    execFileSync('git', ['for-each-ref', '--include-root-refs'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

describe('a failed Git state capture read logs why', () => {
  test('names the repository, the working directory, the read, and what git said, and the command still does not run', async () => {
    const fixture = repoFixture();
    try {
      const { logger, lines } = makeCapturingLogger();
      const seen: SandboxExecParams[] = [];
      const sandbox = boundSandbox(
        fixture,
        failingToplevelProvider(fixture, seen, `fatal: detected dubious ownership in repository at '${fixture.repo}'`),
        logger,
      );
      const result = await run({ sandbox, fixture, command: 'test -f f.txt', purpose: 'verify', approved: true });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        'Could not capture the Git repository state before verification. The command was not run.',
      );
      const failures = lines().filter(line => line.message === 'Git repository state capture failed');
      expect(failures).toHaveLength(1);
      const [failure] = failures;
      if (failure === undefined) {
        throw new Error('expected one capture failure log line');
      }
      expect(failure.level).toBe('warn');
      expect(failure.repositoryId).toBe('repo-1');
      expect(failure.workspaceRoot).toBe(fixture.repo);
      expect(failure.read).toBe('git rev-parse --show-toplevel');
      expect(failure.cwd).toBe(fixture.repo);
      expect(failure.exitCode).toBe(128);
      expect(failure.error).toBe(`fatal: detected dubious ownership in repository at '${fixture.repo}'`);
      expect(seen.some(params => params.command.includes('test -f f.txt'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps only the bounded start of a long error output', async () => {
    const fixture = repoFixture();
    try {
      const { logger, lines } = makeCapturingLogger();
      const sandbox = boundSandbox(fixture, failingToplevelProvider(fixture, [], `fatal: ${'x'.repeat(2000)}`), logger);
      const result = await run({ sandbox, fixture, command: 'test -f f.txt', purpose: 'verify', approved: true });
      expect(result.isError).toBe(true);
      const failures = lines().filter(line => line.message === 'Git repository state capture failed');
      expect(failures).toHaveLength(1);
      const [failure] = failures;
      if (failure === undefined) {
        throw new Error('expected one capture failure log line');
      }
      expect(typeof failure.error).toBe('string');
      if (typeof failure.error === 'string') {
        expect(failure.error.length).toBe(500);
        expect(failure.error.startsWith('fatal: ')).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe('the refs read on a git without the root refs flag', () => {
  test('a workspace edit still lands when git rejects the flag, after one retry without it', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      // stripRefsFlag off: the real git here answers the capture exactly as it is.
      const sandbox = boundSandbox(fixture, realProvider(fixture, seen, { stripRefsFlag: false }));
      const result = await writeNewFile({ sandbox, fixture, path: 'added.txt', content: 'hello\n' });
      expect(result.isError).toBe(false);
      expect(existsSync(join(fixture.repo, 'added.txt'))).toBe(true);
      const commands = refsCommands(seen);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands[0]).toContain('--include-root-refs');
      if (!localGitAcceptsRootRefsFlag(fixture.repo)) {
        // The first read was refused for the flag alone, so a later read ran without it.
        expect(commands.some(command => !command.includes('--include-root-refs'))).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('the refs read keeps the flag when git accepts the read', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const sandbox = boundSandbox(fixture, realProvider(fixture, seen));
      const result = await writeNewFile({ sandbox, fixture, path: 'added.txt', content: 'hello\n' });
      expect(result.isError).toBe(false);
      const commands = refsCommands(seen);
      expect(commands.length).toBeGreaterThan(0);
      // Every refs read the capture sent carried the flag; none was retried without it.
      expect(commands.every(command => command.includes('--include-root-refs'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('a refs read that fails for another reason still blocks the edit, with no retry', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const sandbox = boundSandbox(fixture, failingRefsProvider(fixture, seen, 'fatal: the refs store is damaged'));
      const result = await writeNewFile({ sandbox, fixture, path: 'added.txt', content: 'hello\n' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Could not capture Git state');
      expect(existsSync(join(fixture.repo, 'added.txt'))).toBe(false);
      const commands = refsCommands(seen);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('--include-root-refs');
    } finally {
      fixture.cleanup();
    }
  });

  test('a rejection naming a different option is not retried either', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const sandbox = boundSandbox(fixture, failingRefsProvider(fixture, seen, "error: unknown option `frobnicate'"));
      const result = await writeNewFile({ sandbox, fixture, path: 'added.txt', content: 'hello\n' });
      expect(result.isError).toBe(true);
      expect(existsSync(join(fixture.repo, 'added.txt'))).toBe(false);
      expect(refsCommands(seen)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });
});
