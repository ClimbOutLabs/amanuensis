/**
 * Git history for a vault's pages. Every change Aman makes to `people/` or `matters/` is one commit,
 * and a hand edit is a page that differs from the last commit.
 *
 * The history lives in its own git folder, `<vault>/.memory-history`, with the vault as the work tree. A vault
 * that is already a git repository is never touched: its `.git`, its `.gitignore` and its config stay as they
 * are. Only page files are ever staged. Every call goes through a runner with no shell and carries its own
 * identity and safety settings on the command line, so no config file on the machine is needed or read.
 */
import type { HostCommandRunner } from '@truefoundry/trueforge-core/core';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The git folder that holds the history, inside the vault. Never exported and never loaded as a page. */
export const VAULT_HISTORY_DIR = '.memory-history';

/** Only page files, directly in `people/` and `matters/`, are tracked. Everything else in the vault is ignored. */
const HISTORY_EXCLUDE = `${[
  '/*',
  '!/people/',
  '!/matters/',
  '/people/*',
  '!/people/*.md',
  '/matters/*',
  '!/matters/*.md',
].join('\n')}\n`;

const PAGE_FOLDER_NAMES = ['people', 'matters'] as const;

/** Commit identity for every commit in the history. */
const HISTORY_IDENTITY = { name: 'Aman memory', email: 'memory@localhost' } as const;

/** Git is given this long per call; a vault is small. */
export const VAULT_GIT_TIMEOUT_MS = 30_000;

/** Where git is looked for: host installs keep it under /usr/local/bin or Homebrew. */
const VAULT_GIT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';

/** Thrown when git is not installed. Pages are still saved without history. */
export class GitMissingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Git is not installed on this server, so page history is off. Pages are still saved.', options);
    this.name = 'GitMissingError';
  }
}

/** A git call that failed. `message` is for the person; `cause` carries the exit code and what git said. */
export class VaultGitError extends Error {
  constructor(options: { cause: unknown }) {
    super("Page history could not be updated. Check that the server's storage has room and try again.", options);
    this.name = 'VaultGitError';
  }
}

export interface VaultGitOptions {
  vaultDir: string;
  runner: HostCommandRunner;
  timeoutMs?: number | undefined;
}

function historyDir(vaultDir: string): string {
  return path.join(vaultDir, VAULT_HISTORY_DIR);
}

/**
 * The argv for one git call: `git`, the settings on the command line (the vault as a safe directory, the
 * commit identity, no automatic cleanup, no line ending changes, no hooks, no file system monitor, no signing),
 * the git folder and work tree, then `args`. Exported so tests can check exactly what runs.
 */
export function vaultGitArgv({ vaultDir, args }: { vaultDir: string; args: readonly string[] }): string[] {
  const settings = [
    `safe.directory=${vaultDir}`,
    `user.name=${HISTORY_IDENTITY.name}`,
    `user.email=${HISTORY_IDENTITY.email}`,
    'gc.auto=0',
    'core.autocrlf=false',
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.excludesFile=/dev/null',
    'core.quotePath=false',
    'commit.gpgsign=false',
    'init.defaultBranch=main',
  ];
  return [
    'git',
    ...settings.flatMap(setting => ['-c', setting]),
    `--git-dir=${historyDir(vaultDir)}`,
    `--work-tree=${vaultDir}`,
    ...args,
  ];
}

/** The environment every git call runs with. Nothing is read from the server's own environment. */
function vaultGitEnv(vaultDir: string): Record<string, string> {
  return {
    PATH: VAULT_GIT_PATH,
    HOME: historyDir(vaultDir),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
  };
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One git call in the vault. A non-zero exit is returned, not thrown; git being absent throws `GitMissingError`. */
async function git({ options, args }: { options: VaultGitOptions; args: readonly string[] }): Promise<GitResult> {
  const result = await options.runner.run({
    argv: vaultGitArgv({ vaultDir: options.vaultDir, args }),
    env: vaultGitEnv(options.vaultDir),
    cwd: options.vaultDir,
    timeoutMs: options.timeoutMs ?? VAULT_GIT_TIMEOUT_MS,
    signal: undefined,
    maxStdoutBytes: 10_000_000,
  });
  const outcome = { exitCode: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
  if (outcome.exitCode === -1 && outcome.stderr.includes('ENOENT')) {
    throw new GitMissingError({ cause: new Error(outcome.stderr) });
  }
  return outcome;
}

async function gitOrThrow({
  options,
  args,
}: {
  options: VaultGitOptions;
  args: readonly string[];
}): Promise<GitResult> {
  const result = await git({ options, args });
  if (result.exitCode !== 0) {
    throw failure({ args, result });
  }
  return result;
}

function failure({ args, result }: { args: readonly string[]; result: GitResult }): VaultGitError {
  return new VaultGitError({
    cause: new Error(`git ${args[0] ?? ''} exited ${String(result.exitCode)}: ${result.stderr}`),
  });
}

/**
 * Makes the history ready: creates the git folder when it is missing (with no templates, so no sample hooks)
 * and writes the list of what may be tracked into it. The vault's own files are never written.
 */
export async function ensureHistory(options: VaultGitOptions): Promise<void> {
  const folder = historyDir(options.vaultDir);
  if (!(await isDirectory(folder))) {
    await mkdir(options.vaultDir, { recursive: true });
    await gitOrThrow({ options, args: ['init', '-q', '--template='] });
  }
  const excludeFile = path.join(folder, 'info', 'exclude');
  if ((await readIfPresent(excludeFile)) !== HISTORY_EXCLUDE) {
    await mkdir(path.dirname(excludeFile), { recursive: true });
    await writeFile(excludeFile, HISTORY_EXCLUDE);
  }
  await clearStaleIndexLock(options);
}

/**
 * The page files that differ from the last commit, or that are not in it yet, as paths relative to the vault,
 * sorted. Empty when every page matches. A page that was deleted is listed too.
 */
export async function changedPagePaths(options: VaultGitOptions): Promise<string[]> {
  const { stdout } = await gitOrThrow({
    options,
    args: ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
  });
  return stdout
    .split('\0')
    .filter(entry => entry.length > 3)
    .map(entry => entry.slice(3))
    .sort();
}

/**
 * Stages the pages and commits them under `message`. Returns `{ committed: false }` when no page changed, so a
 * pass that changed nothing leaves no empty commit. Only `people/` and `matters/` are ever named to git.
 */
export async function commitPages(
  options: VaultGitOptions & { message: string },
): Promise<{ committed: true; sha: string } | { committed: false }> {
  await clearStaleIndexLock(options);
  const folders = await existingPageFolders(options.vaultDir);
  if (folders.length > 0) {
    await gitOrThrow({ options, args: ['add', '-A', '--', ...folders] });
  }
  const staged = await git({ options, args: ['diff', '--cached', '--quiet'] });
  if (staged.exitCode === 0) {
    return { committed: false };
  }
  if (staged.exitCode !== 1) {
    throw failure({ args: ['diff'], result: staged });
  }
  await gitOrThrow({ options, args: ['commit', '-q', '--no-verify', '-m', options.message] });
  const { stdout } = await gitOrThrow({ options, args: ['rev-parse', 'HEAD'] });
  return { committed: true, sha: stdout.trim() };
}

/** A page as the last commit has it, or undefined when the last commit does not have that page. */
export async function pageAtLastCommit(
  options: VaultGitOptions & { relativePath: string },
): Promise<string | undefined> {
  const result = await git({ options, args: ['show', `HEAD:${options.relativePath}`] });
  return result.exitCode === 0 ? result.stdout : undefined;
}

async function existingPageFolders(vaultDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of PAGE_FOLDER_NAMES) {
    if (await isDirectory(path.join(vaultDir, folder))) {
      found.push(folder);
    }
  }
  return found;
}

/**
 * Removes an `index.lock` left by a git call that was cut off. Callers hold the vault lock, so no other call of
 * ours is running, and a live call cannot outlast its time limit, so an older lock file is dead.
 */
async function clearStaleIndexLock(options: VaultGitOptions): Promise<void> {
  const lockPath = path.join(historyDir(options.vaultDir), 'index.lock');
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > (options.timeoutMs ?? VAULT_GIT_TIMEOUT_MS)) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}
