import type { HostCommandRunner } from '@truefoundry/trueforge-core/core';
import { execFileRunner } from '@truefoundry/trueforge-core/core';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  changedPagePaths,
  commitPages,
  ensureHistory,
  GitMissingError,
  pageAtLastCommit,
  VAULT_HISTORY_DIR,
  vaultGitArgv,
} from '../../../../src/runtime/memory/vaultGit';

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'git-'));
}

async function put(vaultDir: string, relativePath: string, content: string): Promise<void> {
  const file = path.join(vaultDir, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Runs a git command against the history the way an operator undoing a change by hand would. */
function history(vaultDir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [`--git-dir=${path.join(vaultDir, VAULT_HISTORY_DIR)}`, `--work-tree=${vaultDir}`, ...args],
    { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
  );
}

/** Every file under a folder with its bytes, so a test can prove nothing in it changed. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out[path.relative(root, full)] = (await readFile(full)).toString('base64');
      }
    }
  };
  await walk(root);
  return out;
}

function recording(): { runner: HostCommandRunner; calls: { argv: readonly string[]; env: Record<string, string> }[] } {
  const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
  return {
    calls,
    runner: {
      run: input => {
        calls.push({ argv: input.argv, env: { ...input.env } });
        return execFileRunner.run(input);
      },
    },
  };
}

describe('vaultGit', () => {
  it('keeps history in its own folder and lists only pages as trackable', async () => {
    const vaultDir = await makeVault();
    await ensureHistory({ vaultDir, runner: execFileRunner });
    expect((await stat(path.join(vaultDir, VAULT_HISTORY_DIR))).isDirectory()).toBe(true);
    await expect(stat(path.join(vaultDir, '.git'))).rejects.toThrow();
    await expect(stat(path.join(vaultDir, '.gitignore'))).rejects.toThrow();
  });

  it('stages and commits only people/ and matters/ pages, whatever else is in the vault', async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, 'people/nora.md', 'a\n');
    await put(vaultDir, 'matters/trip.md', 'b\n');
    await put(vaultDir, 'people/photo.png', 'not a page');
    await put(vaultDir, 'people/nested/deep.md', 'too deep');
    await put(vaultDir, 'people/.nora.md.tmp-1234', 'a crashed write');
    await put(vaultDir, 'MEMORY.md', 'the long-term file');
    await put(vaultDir, 'memory/2026-11-06.md', 'the daily log');
    await put(vaultDir, '.memory-state/aliases.json', '{}');
    await put(vaultDir, '.operations.json', '{}');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    expect(await changedPagePaths({ vaultDir, runner: execFileRunner })).toEqual(['matters/trip.md', 'people/nora.md']);
    const outcome = await commitPages({ vaultDir, runner: execFileRunner, message: 'Your edits' });
    expect(outcome.committed).toBe(true);
    expect(history(vaultDir, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n')).toEqual([
      'matters/trip.md',
      'people/nora.md',
    ]);
    expect(history(vaultDir, 'log', '--format=%an <%ae> %s')).toBe('Aman memory <memory@localhost> Your edits\n');
  });

  it("is not hidden by the vault's own ignore files, and still stages nothing outside the page folders", async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, '.gitignore', 'people/\nmatters/*.md\n*.md\n');
    await put(vaultDir, 'people/.gitignore', '*\n');
    await put(vaultDir, 'people/nora.md', 'a\n');
    await put(vaultDir, 'matters/trip.md', 'b\n');
    await put(vaultDir, 'people/photo.png', 'not a page');
    await put(vaultDir, 'people/nested/deep.md', 'too deep');
    await put(vaultDir, 'MEMORY.md', 'the long-term file');
    await put(vaultDir, 'notes.md', 'outside');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    expect(await changedPagePaths({ vaultDir, runner: execFileRunner })).toEqual(['matters/trip.md', 'people/nora.md']);
    await commitPages({ vaultDir, runner: execFileRunner, message: 'first' });
    expect(history(vaultDir, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n')).toEqual([
      'matters/trip.md',
      'people/nora.md',
    ]);
    await put(vaultDir, 'people/nora.md', 'changed\n');
    await (await import('node:fs/promises')).rm(path.join(vaultDir, 'matters', 'trip.md'));
    expect(await changedPagePaths({ vaultDir, runner: execFileRunner })).toEqual(['matters/trip.md', 'people/nora.md']);
  });

  it('works when a page folder is missing or empty', async () => {
    const vaultDir = await makeVault();
    await ensureHistory({ vaultDir, runner: execFileRunner });
    expect(await changedPagePaths({ vaultDir, runner: execFileRunner })).toEqual([]);
    await mkdir(path.join(vaultDir, 'matters'));
    expect(await commitPages({ vaultDir, runner: execFileRunner, message: 'none' })).toEqual({ committed: false });
  });

  it('commits nothing when no page changed, and notices edits, additions and deletions', async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, 'people/a.md', '1\n');
    await put(vaultDir, 'people/b.md', '1\n');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    await commitPages({ vaultDir, runner: execFileRunner, message: 'first' });
    expect(await commitPages({ vaultDir, runner: execFileRunner, message: 'again' })).toEqual({ committed: false });
    await put(vaultDir, 'people/a.md', '2\n');
    await put(vaultDir, 'matters/c.md', '1\n');
    await (await import('node:fs/promises')).rm(path.join(vaultDir, 'people', 'b.md'));
    expect(await changedPagePaths({ vaultDir, runner: execFileRunner })).toEqual([
      'matters/c.md',
      'people/a.md',
      'people/b.md',
    ]);
    expect(history(vaultDir, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('reads a page as the last commit has it', async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, 'people/a.md', 'old\n');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    expect(await pageAtLastCommit({ vaultDir, runner: execFileRunner, relativePath: 'people/a.md' })).toBeUndefined();
    await commitPages({ vaultDir, runner: execFileRunner, message: 'first' });
    await put(vaultDir, 'people/a.md', 'new\n');
    expect(await pageAtLastCommit({ vaultDir, runner: execFileRunner, relativePath: 'people/a.md' })).toBe('old\n');
    expect(
      await pageAtLastCommit({ vaultDir, runner: execFileRunner, relativePath: 'people/none.md' }),
    ).toBeUndefined();
  });

  it('can be undone by hand with git and the history folder', async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, 'people/a.md', 'one\n');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    await commitPages({ vaultDir, runner: execFileRunner, message: 'first' });
    await put(vaultDir, 'people/a.md', 'two\n');
    await commitPages({ vaultDir, runner: execFileRunner, message: 'second' });
    history(vaultDir, 'checkout', 'HEAD~1', '--', 'people/a.md');
    expect(await readFile(path.join(vaultDir, 'people', 'a.md'), 'utf8')).toBe('one\n');
  });

  describe('a vault that is already a git repository', () => {
    it('is not touched: its .git, .gitignore and config stay byte for byte', async () => {
      const vaultDir = await makeVault();
      execFileSync('git', ['init', '-q'], { cwd: vaultDir });
      await writeFile(path.join(vaultDir, '.gitignore'), 'secret.txt\n');
      await put(vaultDir, 'people/nora.md', 'a\n');
      execFileSync('git', ['add', '.'], { cwd: vaultDir });
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'theirs'], {
        cwd: vaultDir,
      });
      const before = await snapshot(path.join(vaultDir, '.git'));
      const ignoreBefore = await readFile(path.join(vaultDir, '.gitignore'), 'utf8');

      await ensureHistory({ vaultDir, runner: execFileRunner });
      await put(vaultDir, 'people/nora.md', 'b\n');
      await commitPages({ vaultDir, runner: execFileRunner, message: 'ours' });

      expect(await snapshot(path.join(vaultDir, '.git'))).toEqual(before);
      expect(await readFile(path.join(vaultDir, '.gitignore'), 'utf8')).toBe(ignoreBefore);
      expect(execFileSync('git', ['log', '--format=%s'], { cwd: vaultDir, encoding: 'utf8' })).toBe('theirs\n');
      expect(history(vaultDir, 'log', '--format=%s')).toBe('ours\n');
    });
  });

  describe('hooks', () => {
    it("never run: a failing hook in the history or in the vault's own repo does nothing", async () => {
      const vaultDir = await makeVault();
      execFileSync('git', ['init', '-q'], { cwd: vaultDir });
      const mark = path.join(vaultDir, 'hook-ran');
      const hook = `#!/bin/sh\ntouch '${mark}'\nexit 1\n`;
      for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg', 'pre-merge-commit']) {
        await put(vaultDir, `.git/hooks/${name}`, hook);
        await chmod(path.join(vaultDir, '.git', 'hooks', name), 0o755);
      }
      await put(vaultDir, 'people/a.md', '1\n');
      await ensureHistory({ vaultDir, runner: execFileRunner });
      for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg']) {
        await put(vaultDir, `${VAULT_HISTORY_DIR}/hooks/${name}`, hook);
        await chmod(path.join(vaultDir, VAULT_HISTORY_DIR, 'hooks', name), 0o755);
      }
      expect(await commitPages({ vaultDir, runner: execFileRunner, message: 'ours' })).toMatchObject({
        committed: true,
      });
      await expect(stat(mark)).rejects.toThrow();
      // Control: the same hook does stop an ordinary commit, so the check above means something.
      expect(() =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], {
          cwd: vaultDir,
          stdio: 'ignore',
        }),
      ).toThrow();
      await expect(stat(mark)).resolves.toBeDefined();
    });

    it('are not even copied in: the history starts with no sample hooks', async () => {
      const vaultDir = await makeVault();
      await ensureHistory({ vaultDir, runner: execFileRunner });
      await expect(stat(path.join(vaultDir, VAULT_HISTORY_DIR, 'hooks'))).rejects.toThrow();
    });
  });

  describe('every call', () => {
    it('goes through the runner with git as the program, explicit settings, and no reliance on config files', async () => {
      const vaultDir = await makeVault();
      const { runner, calls } = recording();
      await put(vaultDir, 'people/a.md', '1\n');
      await ensureHistory({ vaultDir, runner });
      await changedPagePaths({ vaultDir, runner });
      await commitPages({ vaultDir, runner, message: 'ours' });
      await pageAtLastCommit({ vaultDir, runner, relativePath: 'people/a.md' });
      expect(calls.length).toBeGreaterThan(5);
      for (const call of calls) {
        expect(call.argv[0]).toBe('git');
        for (const setting of [
          `safe.directory=${vaultDir}`,
          'user.name=Aman memory',
          'user.email=memory@localhost',
          'gc.auto=0',
          'core.autocrlf=false',
          'core.hooksPath=/dev/null',
          'core.fsmonitor=false',
        ]) {
          const at = call.argv.indexOf(setting);
          expect(at).toBeGreaterThan(0);
          expect(call.argv[at - 1]).toBe('-c');
        }
        expect(call.argv).toContain(`--git-dir=${path.join(vaultDir, VAULT_HISTORY_DIR)}`);
        expect(call.argv).toContain(`--work-tree=${vaultDir}`);
        expect(call.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
        expect(Object.keys(call.env).sort()).toEqual(
          ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH'].sort(),
        );
      }
      const commit = calls.find(call => call.argv.includes('commit'));
      expect(commit?.argv).toContain('--no-verify');
      expect(vaultGitArgv({ vaultDir: '/v', args: ['status'] }).slice(-1)).toEqual(['status']);
    });
  });

  it('removes an index lock left by a git call that was cut off', async () => {
    const vaultDir = await makeVault();
    await put(vaultDir, 'people/a.md', '1\n');
    await ensureHistory({ vaultDir, runner: execFileRunner });
    const lock = path.join(vaultDir, VAULT_HISTORY_DIR, 'index.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    expect(await commitPages({ vaultDir, runner: execFileRunner, message: 'ours' })).toMatchObject({ committed: true });
  });

  describe('git is not installed', () => {
    const missing: HostCommandRunner = {
      run: () => Promise.resolve({ exitCode: -1, stdout: Buffer.alloc(0), stderr: 'spawn git ENOENT' }),
    };

    it('says so with a plain message', async () => {
      const vaultDir = await makeVault();
      await expect(ensureHistory({ vaultDir, runner: missing })).rejects.toThrow(GitMissingError);
      await expect(ensureHistory({ vaultDir, runner: missing })).rejects.toThrow(
        'Git is not installed on this server, so page history is off. Pages are still saved.',
      );
    });
  });
});
