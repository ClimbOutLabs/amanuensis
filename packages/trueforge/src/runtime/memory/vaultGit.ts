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

/**
 * The only paths ever staged: `.md` files directly in the two page folders. `--force` makes git skip the vault's own
 * ignore files for them, and the glob pathspec keeps it from reaching anything else, so a `.gitignore` in the vault
 * cannot hide a page from the history.
 */
const PAGE_PATHSPECS = PAGE_FOLDER_NAMES.map(folder => `:(glob)${folder}/*.md`);

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
  await stagePages(options);
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
  await stagePages(options);
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

/** One entry in the page history: a commit, when it was made, what it said, and the page files it touched. */
export interface PageCommit {
  sha: string;
  committedAt: string;
  message: string;
  /** Vault-relative page paths such as `people/nora.md`, sorted. */
  paths: string[];
}

const COMMIT_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';
const COMMIT_FORMAT = `--format=${COMMIT_SEPARATOR}%H${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s`;
/** A history entry's id: the full commit id. */
export const PAGE_COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/;

/** A history with no commits yet, or none at all, has nothing to list. */
const EMPTY_HISTORY_PATTERN = /does not have any commits yet|not a git repository|bad default revision/;

function parseCommits(stdout: string): PageCommit[] {
  return stdout
    .split(COMMIT_SEPARATOR)
    .filter(block => block.trim() !== '')
    .flatMap(block => {
      const [header = '', ...rest] = block.split('\n');
      const [sha, committedAt, ...subject] = header.split(FIELD_SEPARATOR);
      if (sha === undefined || committedAt === undefined) {
        return [];
      }
      const paths = rest.filter(line => line !== '').sort();
      return [{ sha, committedAt, message: subject.join(FIELD_SEPARATOR), paths }];
    });
}

async function readCommits({
  options,
  args,
}: {
  options: VaultGitOptions;
  args: readonly string[];
}): Promise<PageCommit[]> {
  const result = await git({ options, args: ['log', '--no-renames', '--name-only', COMMIT_FORMAT, ...args] });
  if (result.exitCode !== 0) {
    if (EMPTY_HISTORY_PATTERN.test(result.stderr)) {
      return [];
    }
    throw failure({ args: ['log'], result });
  }
  return parseCommits(result.stdout);
}

/** The newest history entries, newest first. Empty when the vault has no history yet. */
export async function recentPageCommits(options: VaultGitOptions & { limit: number }): Promise<PageCommit[]> {
  return readCommits({ options, args: [`--max-count=${String(options.limit)}`, '--'] });
}

/** One history entry by its full id, or undefined when the history has no such entry. */
export async function pageCommit(options: VaultGitOptions & { sha: string }): Promise<PageCommit | undefined> {
  if (!PAGE_COMMIT_ID_PATTERN.test(options.sha)) {
    return undefined;
  }
  const result = await git({
    options,
    args: ['log', '--no-renames', '--name-only', COMMIT_FORMAT, '--max-count=1', options.sha, '--'],
  });
  return result.exitCode === 0 ? parseCommits(result.stdout)[0] : undefined;
}

/** The entries made after `sha` that touched any of `paths`, newest first. */
export async function pageCommitsAfter(
  options: VaultGitOptions & { sha: string; paths: readonly string[] },
): Promise<PageCommit[]> {
  if (!PAGE_COMMIT_ID_PATTERN.test(options.sha) || options.paths.length === 0) {
    return [];
  }
  return readCommits({
    options,
    args: [`${options.sha}..HEAD`, '--', ...options.paths.map(relativePath => `:(literal)${relativePath}`)],
  });
}

/** Which of `paths` differ between an entry and the newest entry. Empty when none do. */
export async function pagePathsDiffering(
  options: VaultGitOptions & { sha: string; paths: readonly string[] },
): Promise<string[]> {
  if (!PAGE_COMMIT_ID_PATTERN.test(options.sha) || options.paths.length === 0) {
    return [];
  }
  const { stdout } = await gitOrThrow({
    options,
    args: [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      options.sha,
      'HEAD',
      '--',
      ...options.paths.map(relativePath => `:(literal)${relativePath}`),
    ],
  });
  return stdout
    .split('\0')
    .filter(entry => entry !== '')
    .sort();
}

/** A page as it was just before an entry, or undefined when the page did not exist then. */
export async function pageBeforeCommit(
  options: VaultGitOptions & { sha: string; relativePath: string },
): Promise<string | undefined> {
  if (!PAGE_COMMIT_ID_PATTERN.test(options.sha)) {
    return undefined;
  }
  const result = await git({ options, args: ['show', `${options.sha}^:${options.relativePath}`] });
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** Stages every page change, including a deleted page, and nothing else. */
async function stagePages(options: VaultGitOptions): Promise<void> {
  await clearStaleIndexLock(options);
  for (const pathspec of PAGE_PATHSPECS) {
    const args = ['add', '-A', '--force', '--', pathspec];
    const result = await git({ options, args });
    // A folder with no pages yet matches nothing, which is not a failure.
    if (result.exitCode !== 0 && !result.stderr.includes('did not match any files')) {
      throw failure({ args, result });
    }
  }
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
