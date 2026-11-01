/**
 * Git history for a vault's pages. Every write Aman makes to `people/` or `matters/` is one
 * commit; a hand edit is a page that differs from HEAD. The repo tracks pages only (the
 * `.gitignore` is a whitelist), so a revert can never touch the daily log.
 *
 * Every call goes through a `HostCommandRunner` with no shell, explicit identity and
 * safety settings on the command line, and no global or system config, so a Docker volume
 * owned by another user and a missing home directory both work.
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';

import type { HostCommandRunner } from '@truefoundry/trueforge-core/core/sandbox/slots/git/hostCommand';

/** The whitelist: nothing but pages and this file are ever tracked. */
export const VAULT_GITIGNORE_LINES = [
  '*',
  '!.gitignore',
  '!people/',
  '!people/**',
  '!matters/',
  '!matters/**',
  // Page writes go through `.<slug>.md.tmp-<id>`; a crash must not leave one to be committed.
  '.*.tmp-*',
] as const;

/** Commit identity for Aman's own writes; the person's edits are committed under the same name as `Your edits`. */
export const VAULT_GIT_IDENTITY = { name: 'Aman memory', email: 'memory@localhost' } as const;

/** Git is given this long per call; the vault is small. */
export const VAULT_GIT_TIMEOUT_MS = 30_000;

/** Where git is looked for: host-dev installs put it under /usr/local/bin or Homebrew. */
const VAULT_GIT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';

/** A git call that failed. `message` is for the person; `cause` carries the exit code and stderr. */
export class VaultGitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultGitError';
  }
}

export interface VaultGitOptions {
  vaultDir: string;
  runner: HostCommandRunner;
  timeoutMs?: number | undefined;
}

/**
 * The argv for one git call in the vault: `git`, then `-c` settings (`safe.directory`
 * set to the vault, `user.name` / `user.email` from `VAULT_GIT_IDENTITY`, `gc.auto=0`,
 * `core.autocrlf=false`, `commit.gpgsign=false`), then `args`. Exported so tests can
 * check what runs.
 */
export function vaultGitArgv({ vaultDir, args }: { vaultDir: string; args: readonly string[] }): string[] {
  return [
    'git',
    '-c',
    `safe.directory=${vaultDir}`,
    '-c',
    `user.name=${VAULT_GIT_IDENTITY.name}`,
    '-c',
    `user.email=${VAULT_GIT_IDENTITY.email}`,
    '-c',
    'gc.auto=0',
    '-c',
    'core.autocrlf=false',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ];
}

/**
 * The environment every git call runs with: a fixed `PATH` of the standard git locations, `HOME` set to the vault,
 * `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` pointing at the null device, `LC_ALL=C`,
 * `GIT_TERMINAL_PROMPT=0`. Nothing is read from the process environment.
 */
export function vaultGitEnv(vaultDir: string): Record<string, string> {
  return {
    PATH: VAULT_GIT_PATH,
    HOME: vaultDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Makes the vault a repo with the whitelist `.gitignore`: `git init -q` when `.git` is
 * missing, then writes `.gitignore` when it is missing or differs, and commits that one file
 * as `Start keeping memory history`. Nothing else is staged or committed, so pages the person
 * changed by hand stay uncommitted for the caller to take in under their own name.
 */
export async function ensureVaultRepo(options: VaultGitOptions): Promise<void> {
  if (!(await pathExists(path.join(options.vaultDir, '.git')))) {
    await gitOrThrow({ options, args: ['init', '-q'] });
  }
  await clearStaleIndexLock(options);
  const gitignorePath = path.join(options.vaultDir, '.gitignore');
  const expected = `${VAULT_GITIGNORE_LINES.join('\n')}\n`;
  if ((await readIfPresent(gitignorePath)) !== expected) {
    await writeFile(gitignorePath, expected);
  }
  await gitOrThrow({ options, args: ['add', '--', '.gitignore'] });
  const staged = await git({ options, args: ['diff', '--cached', '--quiet', '--', '.gitignore'] });
  if (staged.exitCode === 1) {
    await gitOrThrow({ options, args: ['commit', '-q', '-m', 'Start keeping memory history', '--', '.gitignore'] });
  } else if (staged.exitCode !== 0) {
    throw gitFailure({ args: ['diff', '--cached'], exitCode: staged.exitCode, stderr: staged.stderr });
  }
}

/**
 * Tracked paths that differ from HEAD plus untracked paths the whitelist admits, relative to
 * the vault, sorted. Empty when the working tree is clean. Read from
 * `git status --porcelain=v1 -z --untracked-files=all`.
 */
export async function vaultChangedPaths(options: VaultGitOptions): Promise<string[]> {
  const { stdout } = await gitOrThrow({
    options,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  });
  const entries = stdout.split('\0');
  const paths: string[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index] ?? '';
    index += 1;
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    // A rename or copy is followed by its original path as a separate entry.
    if (entry.startsWith('R') || entry.startsWith('C')) {
      index += 1;
    }
  }
  return paths.sort();
}

/**
 * Stages everything the whitelist admits (`git add -A`) and commits it. Returns
 * `{ committed: false }` when there was nothing to commit, so a no-op pass leaves no empty
 * commit. `body` becomes further paragraphs of the message.
 */
export async function commitVault(
  options: VaultGitOptions & { message: string; body?: string | undefined },
): Promise<{ committed: true; sha: string } | { committed: false }> {
  await clearStaleIndexLock(options);
  await gitOrThrow({ options, args: ['add', '-A'] });
  const staged = await git({ options, args: ['diff', '--cached', '--quiet'] });
  if (staged.exitCode === 0) {
    return { committed: false };
  }
  if (staged.exitCode !== 1) {
    throw gitFailure({ args: ['diff', '--cached', '--quiet'], exitCode: staged.exitCode, stderr: staged.stderr });
  }
  const messageArgs = options.body === undefined ? [] : ['-m', options.body];
  await gitOrThrow({ options, args: ['commit', '-q', '-m', options.message, ...messageArgs] });
  const { stdout } = await gitOrThrow({ options, args: ['rev-parse', 'HEAD'] });
  return { committed: true, sha: stdout.trim() };
}

/** The committed text of a vault-relative path at HEAD, or undefined when HEAD has no such file. */
export async function vaultFileAtHead(
  options: VaultGitOptions & { relativePath: string },
): Promise<string | undefined> {
  const result = await git({ options, args: ['show', `HEAD:${options.relativePath}`] });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout;
}

/**
 * Removes a `.git/index.lock` left by a crashed git call. Callers hold the vault lock, so no other
 * Aman git call is running here, and a live call cannot outlast its timeout: an older lock is dead.
 */
async function clearStaleIndexLock(options: VaultGitOptions): Promise<void> {
  const lockPath = path.join(options.vaultDir, '.git', 'index.lock');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  if (Date.now() - mtimeMs > (options.timeoutMs ?? VAULT_GIT_TIMEOUT_MS)) {
    await rm(lockPath, { force: true });
  }
}

/** One git call in the vault; never throws on a non-zero exit. */
async function git({
  options,
  args,
}: {
  options: VaultGitOptions;
  args: readonly string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await options.runner.run({
    argv: vaultGitArgv({ vaultDir: options.vaultDir, args }),
    env: vaultGitEnv(options.vaultDir),
    cwd: options.vaultDir,
    timeoutMs: options.timeoutMs ?? VAULT_GIT_TIMEOUT_MS,
    signal: undefined,
    maxStdoutBytes: 10_000_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
}

async function gitOrThrow({
  options,
  args,
}: {
  options: VaultGitOptions;
  args: readonly string[];
}): Promise<{ stdout: string; stderr: string }> {
  const result = await git({ options, args });
  if (result.exitCode !== 0) {
    throw gitFailure({ args, exitCode: result.exitCode, stderr: result.stderr });
  }
  return result;
}

function gitCause({ args, exitCode, stderr }: { args: readonly string[]; exitCode: number; stderr: string }): Error {
  return new Error(`git ${args[0] ?? ''} exited ${String(exitCode)}: ${stderr}`);
}

function gitFailure({
  args,
  exitCode,
  stderr,
}: {
  args: readonly string[];
  exitCode: number;
  stderr: string;
}): VaultGitError {
  return new VaultGitError("Memory history could not be updated. Check the server's storage and try again.", {
    cause: gitCause({ args, exitCode, stderr }),
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
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
