import { execFileRunner, type HostCommandRunner } from '@truefoundry/trueforge-core/core/sandbox/slots/git/hostCommand';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  commitVault,
  ensureVaultRepo,
  revertVaultCommit,
  VAULT_GIT_IDENTITY,
  VAULT_GITIGNORE_LINES,
  vaultChangedPaths,
  vaultFileAtHead,
  vaultGitArgv,
  vaultGitEnv,
  VaultGitError,
  vaultLog,
  VaultRevertConflictError,
} from '../../../../src/runtime/memory/vaultGit';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'vault-git-'));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writePage(vaultDir: string, relativePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(vaultDir, relativePath)), { recursive: true });
  await writeFile(path.join(vaultDir, relativePath), text);
}

const runner = execFileRunner;

describe('vaultGit', () => {
  it('builds argv with explicit identity and safety settings and no shell', () => {
    const argv = vaultGitArgv({ vaultDir: '/data/memory/t1', args: ['status'] });
    expect(argv[0]).toBe('git');
    expect(argv[argv.length - 1]).toBe('status');
    const settings = argv.filter((_part, index) => argv[index - 1] === '-c');
    expect(settings).toEqual(
      expect.arrayContaining([
        'safe.directory=/data/memory/t1',
        `user.name=${VAULT_GIT_IDENTITY.name}`,
        `user.email=${VAULT_GIT_IDENTITY.email}`,
        'gc.auto=0',
        'core.autocrlf=false',
        'commit.gpgsign=false',
      ]),
    );
  });

  it('runs git with a closed environment', () => {
    const env = vaultGitEnv('/data/memory/t1');
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/data/memory/t1');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_CONFIG_GLOBAL']).toBeDefined();
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['LC_ALL']).toBe('C');
  });

  it('makes a repo with the whitelist ignore file, once', async () => {
    const vaultDir = await makeVault();
    await ensureVaultRepo({ vaultDir, runner });
    expect(await exists(path.join(vaultDir, '.git'))).toBe(true);
    expect(await readFile(path.join(vaultDir, '.gitignore'), 'utf8')).toBe(`${VAULT_GITIGNORE_LINES.join('\n')}\n`);
    const log = await vaultLog({ vaultDir, runner, limit: 10 });
    expect(log.map(commit => commit.subject)).toEqual(['Start keeping memory history']);
    await ensureVaultRepo({ vaultDir, runner });
    expect((await vaultLog({ vaultDir, runner, limit: 10 })).length).toBe(1);
  });

  it('tracks pages and nothing else', async () => {
    const vaultDir = await makeVault();
    await ensureVaultRepo({ vaultDir, runner });
    await writePage(vaultDir, 'people/wendy.md', '# Wendy\n');
    await writePage(vaultDir, 'people/wendy.archive.md', '# Wendy (earlier)\n');
    await writePage(vaultDir, 'matters/madrid.md', '# Madrid\n');
    await writePage(vaultDir, 'memory/2026-10-31.md', '## 2026-10-31T10:00:00Z\n\nhello\n');
    await writePage(vaultDir, 'MEMORY.md', 'curated\n');
    await writePage(vaultDir, '.memory-state/cursor', '{}');
    await writePage(vaultDir, '.vault-tombstones.md', '');
    expect(await vaultChangedPaths({ vaultDir, runner })).toEqual([
      'matters/madrid.md',
      'people/wendy.archive.md',
      'people/wendy.md',
    ]);
    const result = await commitVault({ vaultDir, runner, message: 'Nightly: 2 new' });
    expect(result.committed).toBe(true);
    expect(await vaultChangedPaths({ vaultDir, runner })).toEqual([]);
    expect(await vaultFileAtHead({ vaultDir, runner, relativePath: 'people/wendy.md' })).toBe('# Wendy\n');
    expect(await vaultFileAtHead({ vaultDir, runner, relativePath: 'memory/2026-10-31.md' })).toBeUndefined();
    expect(await vaultFileAtHead({ vaultDir, runner, relativePath: 'people/nobody.md' })).toBeUndefined();
  });

  it('commits nothing when nothing changed', async () => {
    const vaultDir = await makeVault();
    await ensureVaultRepo({ vaultDir, runner });
    expect(await commitVault({ vaultDir, runner, message: 'Nightly: nothing' })).toEqual({ committed: false });
    expect((await vaultLog({ vaultDir, runner, limit: 10 })).length).toBe(1);
  });

  it('keeps the body as further paragraphs and lists newest first', async () => {
    const vaultDir = await makeVault();
    await ensureVaultRepo({ vaultDir, runner });
    await writePage(vaultDir, 'people/wendy.md', 'a\n');
    const first = await commitVault({ vaultDir, runner, message: 'Nightly: 1 new', body: 'f_01 new: first mention' });
    await writePage(vaultDir, 'people/wendy.md', 'b\n');
    const second = await commitVault({ vaultDir, runner, message: 'You: edited Wendy' });
    if (!first.committed || !second.committed) {
      throw new Error('expected two commits');
    }
    const log = await vaultLog({ vaultDir, runner, limit: 2 });
    expect(log).toEqual([
      { sha: second.sha, subject: 'You: edited Wendy' },
      { sha: first.sha, subject: 'Nightly: 1 new' },
    ]);
    const shown = await runner.run({
      argv: vaultGitArgv({ vaultDir, args: ['log', '-1', '--format=%B', first.sha] }),
      env: vaultGitEnv(vaultDir),
      cwd: vaultDir,
      timeoutMs: 10_000,
      signal: undefined,
      maxStdoutBytes: 1_000_000,
    });
    expect(shown.stdout.toString('utf8').trimEnd()).toBe('Nightly: 1 new\n\nf_01 new: first mention');
  });

  it('reverts a commit as a new commit, and refuses when later edits overlap', async () => {
    const vaultDir = await makeVault();
    await ensureVaultRepo({ vaultDir, runner });
    await writePage(vaultDir, 'people/wendy.md', 'line one\n');
    await commitVault({ vaultDir, runner, message: 'You: made Wendy' });
    await writePage(vaultDir, 'people/wendy.md', 'line one\nline two\n');
    const tidy = await commitVault({ vaultDir, runner, message: 'Nightly: 1 new' });
    if (!tidy.committed) {
      throw new Error('expected a commit');
    }
    const reverted = await revertVaultCommit({ vaultDir, runner, sha: tidy.sha });
    expect(await readFile(path.join(vaultDir, 'people/wendy.md'), 'utf8')).toBe('line one\n');
    const log = await vaultLog({ vaultDir, runner, limit: 1 });
    expect(log[0]?.sha).toBe(reverted.sha);
    expect(log[0]?.subject).toContain('Revert');

    await writePage(vaultDir, 'people/wendy.md', 'line one\nline two\n');
    const again = await commitVault({ vaultDir, runner, message: 'Nightly: 1 new' });
    await writePage(vaultDir, 'people/wendy.md', 'line one\nline two, edited by hand\n');
    await commitVault({ vaultDir, runner, message: 'Your edits' });
    if (!again.committed) {
      throw new Error('expected a commit');
    }
    await expect(revertVaultCommit({ vaultDir, runner, sha: again.sha })).rejects.toBeInstanceOf(
      VaultRevertConflictError,
    );
    expect(await readFile(path.join(vaultDir, 'people/wendy.md'), 'utf8')).toBe('line one\nline two, edited by hand\n');
    expect(await vaultChangedPaths({ vaultDir, runner })).toEqual([]);
    expect(await exists(path.join(vaultDir, '.git', 'REVERT_HEAD'))).toBe(false);
  });

  it('wraps a failing git call in a plain error that keeps the cause', async () => {
    const failing: HostCommandRunner = {
      run: async () => ({ exitCode: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository' }),
    };
    const vaultDir = await makeVault();
    let caught: unknown;
    try {
      await vaultChangedPaths({ vaultDir, runner: failing });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VaultGitError);
    expect(caught instanceof Error && caught.message).not.toContain('fatal:');
    expect(caught instanceof Error && String(caught.cause)).toContain('fatal: not a git repository');
  });
});
