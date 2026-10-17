import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from 'winston';
import {
  isApprovalRequiredResponse,
  isCallToolResponseResult,
} from '../../../../../../trueforge-core/src/core/mcp/IMCPServer';
import {
  createSentinelHostContext,
  defaultSentinelServices,
} from '../../../../../../trueforge-core/src/core/permissions/context';
import {
  Sandbox,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
} from '../../../../../../trueforge-core/src/core/sandbox/Sandbox';
import { SkillMounter } from '../../../../../../trueforge-core/src/core/sandbox/skills/SkillMounter';
import { NOOP_AGENT_TRACING } from '../../../../../../trueforge-core/src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer } from '../../../../../../trueforge-core/tests/core/harnessMocks';
import { TestDurableWorkspaceCoordinator } from '../../../../../../trueforge-core/tests/core/sandbox/durableWorkspaceCoordinator';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

const execFileAsync = promisify(execFile);

interface Outcome {
  asksForApproval: boolean;
  tier: number | undefined;
  text: string;
}

const PLANTED_OUTPUT = 'PLANTED-PROGRAM-RAN';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('allowlisted commands run the program that was classified (real LocalSandboxProvider)', () => {
  let parent: string;
  let provider: LocalSandboxProvider;
  let sandboxId: string;
  let sandbox: Sandbox;

  beforeEach(async () => {
    const support = await LocalSandboxProvider.isSupported();
    if (!support.supported) {
      pending(`Local sandbox not supported: ${support.reason}`);
    }
    if (!support.supported) {
      throw new Error(support.reason);
    }
    parent = await mkdtemp(join(tmpdir(), 'tfy-allowlisted-exec-'));
    const codeModeSocketParentPath = join(tmpdir(), 'cm');
    await mkdir(codeModeSocketParentPath, { recursive: true, mode: 0o700 });
    provider = new LocalSandboxProvider({
      sandboxRootPathParent: parent,
      codeModeSocketParentPath,
      support,
      logger: createLogger({ silent: true }),
    });
    ({ sandboxId } = await provider.createSandbox());
    sandbox = makeSandbox({});
  }, 120_000);

  function makeSandbox(extra: Partial<ConstructorParameters<typeof Sandbox>[0]>): Sandbox {
    return new Sandbox({
      provider,
      existingSandboxId: sandboxId,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: createLogger({ silent: true }),
      tracing: NOOP_AGENT_TRACING,
      sentinel: createSentinelHostContext({
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        workspace_cwd: sandboxId,
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
      ...extra,
    });
  }

  async function bindRepository(): Promise<void> {
    const git = (...args: string[]): Promise<unknown> => execFileAsync('git', ['-C', sandboxId, ...args]);
    await git('init', '-q');
    await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const boundRepository = { repository_id: 'repo-1', revision: 1, workspace_cwd: sandboxId, commands: [] };
    sandbox = makeSandbox({
      boundRepository,
      loadBoundRepository: () => Promise.resolve(boundRepository),
      workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
      workspaceLeaseOwnerId: 'contract-test',
    });
  }

  afterEach(async () => {
    await provider.dispose();
    await rm(parent, { recursive: true, force: true });
  }, 60_000);

  async function plant(relativePath: string, marker: string): Promise<void> {
    const target = join(sandboxId, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    // Replace the entry itself: the venv's python entries are links to the host interpreter, which a write would follow.
    await rm(target, { force: true });
    await writeFile(target, `#!/bin/sh\necho ${PLANTED_OUTPUT}\necho "$@" >> '${marker}'\n`);
    await chmod(target, 0o755);
  }

  async function run(command: string): Promise<Outcome> {
    return call(SANDBOX_EXEC_TOOL_NAME, { intent: 'inspect', purpose: 'inspect', command, cwd: sandboxId });
  }

  async function writeFileAt(path: string): Promise<Outcome> {
    return call(SANDBOX_WRITE_FILE_TOOL_NAME, { intent: 'edit', path, content: 'x\n', cwd: sandboxId });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
    const response = await sandbox.callTool({ name, arguments: args });
    if (!isCallToolResponseResult(response)) {
      const tier = isApprovalRequiredResponse(response) ? response.approvalRequired.tool_info.tier : undefined;
      return { asksForApproval: true, tier, text: '' };
    }
    const content = response.result.content[0];
    return { asksForApproval: false, tier: undefined, text: content?.type === 'text' ? content.text : '' };
  }

  test.each([
    ['ls hello.txt', '.venv/bin/ls', 'hello.txt'],
    ['ls -l hello.txt', 'mcp-client/bin/ls', 'hello.txt'],
    ['cat hello.txt', '.venv/bin/cat', 'hello'],
    ['nice ls hello.txt', '.venv/bin/nice', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/flock', 'hello.txt'],
    ['ls hello.txt', 'mcp-client/bin/flock', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/sh', 'hello.txt'],
    ['ls hello.txt', 'mcp-client/bin/sh', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/git', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/mkdir', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/rm', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/python', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/python3', 'hello.txt'],
  ])('a planted program cannot stand in for the safe `%s`', async (command, plantedAt, realOutput) => {
    const marker = join(sandboxId, 'planted-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    await plant(plantedAt, marker);
    const outcome = await run(command);
    // A run that aborts or asks would also lack the planted output, so the real program's output must be present.
    expect(outcome.asksForApproval).toBe(false);
    expect(outcome.text).toContain(realOutput);
    expect(outcome.text).not.toContain(PLANTED_OUTPUT);
    // Neither the command nor host bookkeeping may reach a planted program.
    expect(await exists(marker)).toBe(false);
  });

  test.each(['zz.pth', 'sitecustomize.py'])('a planted Python startup file `%s` never runs', async name => {
    const marker = join(sandboxId, 'startup-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    const lib = join(sandboxId, '.venv', 'lib');
    const [pythonDir] = await readdir(lib);
    const body = `import os\nopen(${JSON.stringify(marker)}, 'a').write('ran')\n`;
    const content = name.endsWith('.pth') ? `import os; open(${JSON.stringify(marker)}, 'a').write('ran')\n` : body;
    await writeFile(join(lib, pythonDir ?? '', 'site-packages', name), content);
    const outcome = await run('ls hello.txt');
    expect(outcome.asksForApproval).toBe(false);
    expect(outcome.text).toContain('hello.txt');
    expect(await exists(marker)).toBe(false);
  });

  /** A startup file that logs every interpreter that loads it, into a folder the sandbox cannot write. */
  async function plantStartupFile(sitePackagesDir: string, marker: string): Promise<void> {
    await writeFile(
      join(sitePackagesDir, 'zz_planted.pth'),
      `import os; open(${JSON.stringify(marker)}, 'a').write('pid=%d\\n' % os.getpid())\n`,
    );
  }

  test('recreating a broken workspace venv never runs a planted startup file on the host', async () => {
    const markerDir = await mkdtemp(join(tmpdir(), 'tfy-venv-marker-'));
    try {
      const marker = join(markerDir, 'startup-ran');
      const lib = join(sandboxId, '.venv', 'lib');
      const [pythonDir] = await readdir(lib);
      await plantStartupFile(join(lib, pythonDir ?? '', 'site-packages'), marker);
      // Unlink the entry: it links to the host interpreter, which a write would follow.
      await rm(join(sandboxId, '.venv', 'bin', 'python'));
      const result = await provider.exec({ sandboxId, command: 'echo repaired' });
      expect(await exists(marker)).toBe(false);
      expect(result).toMatchObject({ success: true, response: { exitCode: 0, result: 'repaired\n' } });
      expect(await exists(join(sandboxId, '.venv', 'bin', 'python'))).toBe(true);
      expect(await exists(join(lib, pythonDir ?? '', 'site-packages', 'zz_planted.pth'))).toBe(false);
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  test('a workspace venv that links elsewhere is replaced and the link target is left alone', async () => {
    const markerDir = await mkdtemp(join(tmpdir(), 'tfy-venv-marker-'));
    try {
      const marker = join(markerDir, 'startup-ran');
      const elsewhere = join(markerDir, 'elsewhere');
      const sitePackagesDir = join(elsewhere, 'lib', 'python3', 'site-packages');
      await mkdir(sitePackagesDir, { recursive: true });
      await plantStartupFile(sitePackagesDir, marker);
      await rm(join(sandboxId, '.venv'), { recursive: true, force: true });
      await symlink(elsewhere, join(sandboxId, '.venv'));
      const result = await provider.exec({ sandboxId, command: 'echo repaired' });
      expect(await exists(marker)).toBe(false);
      expect(await readdir(elsewhere)).toEqual(['lib']);
      expect(await exists(join(sitePackagesDir, 'zz_planted.pth'))).toBe(true);
      expect(result).toMatchObject({ success: true, response: { exitCode: 0, result: 'repaired\n' } });
      expect((await lstat(join(sandboxId, '.venv'))).isDirectory()).toBe(true);
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  test('host bookkeeping never runs a planted program from the tool folders', async () => {
    const marker = join(sandboxId, 'planted-ran');
    await writeFile(marker, '');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    for (const name of ['git', 'mkdir', 'rm', 'python', 'python3', 'flock', 'sh', 'env', 'realpath']) {
      await plant(`.venv/bin/${name}`, marker);
      await plant(`mcp-client/bin/${name}`, marker);
    }
    for (const command of ['ls hello.txt', 'cat hello.txt']) {
      const outcome = await run(command);
      expect(outcome.asksForApproval).toBe(false);
      expect(outcome.text).toContain('hello');
      expect(outcome.text).not.toContain(PLANTED_OUTPUT);
    }
    expect(await readFile(marker, 'utf8')).toBe('');
  });

  const PASS_THROUGH_NAMES = [
    'python3',
    'python',
    'git',
    'mkdir',
    'rm',
    'sh',
    'bash',
    'env',
    'flock',
    'realpath',
    'chmod',
    'mv',
    'ln',
    'base64',
    'cat',
    'dirname',
    'readlink',
    'sleep',
    'setsid',
  ];

  /** Logs each run to `marker`, then runs the system program, so a run that reaches one still succeeds. */
  async function plantPassThrough(marker: string): Promise<void> {
    await writeFile(marker, '');
    for (const dir of ['.venv/bin', 'mcp-client/bin']) {
      const binDir = join(sandboxId, dir);
      await mkdir(binDir, { recursive: true });
      expect((await lstat(binDir)).isSymbolicLink()).toBe(false);
      for (const name of PASS_THROUGH_NAMES) {
        const target = join(binDir, name);
        // Replace the entry itself: the venv's python entries are links to the host interpreter.
        await rm(target, { force: true });
        await writeFile(
          target,
          `#!/bin/sh\necho "${dir}/${name} $*" >> '${marker}'\nfor d in /usr/bin /bin; do [ -x "$d/${name}" ] && exec "$d/${name}" "$@"; done\nexit 127\n`,
        );
        await chmod(target, 0o755);
      }
    }
  }

  test('sandbox setup with skills never runs a planted program', async () => {
    const marker = join(sandboxId, 'planted-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    await plantPassThrough(marker);
    sandbox = makeSandbox({ skillMounter: new SkillMounter([]) });
    const outcome = await run('ls hello.txt');
    expect(outcome.text).toContain('hello.txt');
    expect(await readFile(marker, 'utf8')).toBe('');
  });

  test('sandbox setup with code mode never runs a planted program', async () => {
    const marker = join(sandboxId, 'planted-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    await plantPassThrough(marker);
    sandbox.configureCodeMode([makeMockIMCPServer({ name: 'github', preload: true })]);
    const outcome = await run('ls hello.txt');
    expect(outcome.text).toContain('hello.txt');
    expect(await readFile(marker, 'utf8')).toBe('');
  });

  test('the verified commit check never runs a planted program', async () => {
    const marker = join(sandboxId, 'planted-ran');
    await bindRepository();
    await plantPassThrough(marker);
    const result = await provider.executeVerifiedWorkspaceCommit({
      sandboxId,
      workspaceRoot: sandboxId,
      cwd: sandboxId,
      env: {},
      timeoutSeconds: 60,
      command: 'true',
      receipt: {
        branch: 'x',
        head: 'x',
        refsSha256: 'x',
        indexSha256: 'x',
        trackedWorktreeSha256: 'x',
        untrackedSha256: 'x',
      },
    });
    // A stale receipt never dispatches the command.
    expect(result.status).toBe('blocked');
    expect(await readFile(marker, 'utf8')).toBe('');
  });

  test('reading a file never imports a planted Python module', async () => {
    const marker = join(sandboxId, 'module-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    for (const name of ['json', 'base64']) {
      await writeFile(
        join(sandboxId, `${name}.py`),
        `open(${JSON.stringify(marker)}, 'a').write(${JSON.stringify(name)})\n`,
      );
    }
    const content = await provider.downloadFile({ sandboxId, path: 'hello.txt' });
    expect(content.toString('utf8')).toBe('hello\n');
    expect(await exists(marker)).toBe(false);
  });

  test('a write outside the tool folders is an ordinary tier 2 edit', async () => {
    await bindRepository();
    const target = join(sandboxId, 'src', 'x.py');
    await mkdir(join(sandboxId, 'src'), { recursive: true });
    const outcome = await writeFileAt(target);
    expect(outcome.tier).toBe(2);
    expect(await exists(target)).toBe(false);
  });

  async function sitePackages(): Promise<string> {
    const lib = join(sandboxId, '.venv', 'lib');
    const [pythonDir] = await readdir(lib);
    return join(lib, pythonDir ?? '', 'site-packages');
  }

  test.each(['zz.pth', 'sitecustomize.py', 'usercustomize.py'])(
    'a write of `%s` into the venv needs approval and does not happen',
    async name => {
      await bindRepository();
      const target = join(await sitePackages(), name);
      const outcome = await writeFileAt(target);
      expect(outcome.asksForApproval).toBe(true);
      expect(outcome.tier).toBe(3);
      expect(await exists(target)).toBe(false);
    },
  );

  test('a write of pyvenv.cfg needs approval and does not happen', async () => {
    await bindRepository();
    const config = join(sandboxId, '.venv', 'pyvenv.cfg');
    const before = await readFile(config, 'utf8');
    const outcome = await writeFileAt(config);
    expect(outcome.asksForApproval).toBe(true);
    expect(outcome.tier).toBe(3);
    expect(await readFile(config, 'utf8')).toBe(before);
  });

  test('a write into a folder that `mcp-client` links to needs approval', async () => {
    await bindRepository();
    const other = join(sandboxId, 'other-tools');
    await mkdir(other, { recursive: true });
    await rm(join(sandboxId, 'mcp-client'), { recursive: true, force: true });
    await symlink(other, join(sandboxId, 'mcp-client'));
    expect((await lstat(join(sandboxId, 'mcp-client'))).isSymbolicLink()).toBe(true);
    const target = join(other, 'tool.sh');
    const outcome = await writeFileAt(target);
    expect(outcome.asksForApproval).toBe(true);
    expect(outcome.tier).toBe(3);
    expect(await exists(target)).toBe(false);
  });

  test('a write into a folder that `.venv/bin` links to needs approval', async () => {
    await bindRepository();
    const other = join(sandboxId, 'other-bin');
    await mkdir(other, { recursive: true });
    // Removing the folder drops its links to the host interpreter without following them.
    await rm(join(sandboxId, '.venv', 'bin'), { recursive: true, force: true });
    await symlink(other, join(sandboxId, '.venv', 'bin'));
    expect((await lstat(join(sandboxId, '.venv', 'bin'))).isSymbolicLink()).toBe(true);
    const target = join(other, 'ls');
    const outcome = await writeFileAt(target);
    expect(outcome.asksForApproval).toBe(true);
    expect(outcome.tier).toBe(3);
    expect(await exists(target)).toBe(false);
  });

  test('the real program still runs silently and its output is returned', async () => {
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    const outcome = await run('cat hello.txt');
    expect(outcome.asksForApproval).toBe(false);
    expect(outcome.text).toContain('hello');
    expect(await readFile(join(sandboxId, 'hello.txt'), 'utf8')).toBe('hello\n');
  });
});
