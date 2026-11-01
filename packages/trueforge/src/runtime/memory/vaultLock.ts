/**
 * One lock per vault, shared across processes through a lock file, so the nightly pass in the
 * controller and a live chat on a server replica never write pages at the same time. Held
 * only around page writes and git calls; the daily log append path never takes it.
 */
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** The lock file, inside the state folder so git and export never see it. */
export const VAULT_LOCK_FILE = path.join('.memory-state', 'lock');

/** A lock older than this is judged abandoned (a crashed holder) and taken over. */
export const VAULT_LOCK_STALE_AFTER_MS = 60_000;

/** How long a caller waits for a busy vault before giving up. */
export const VAULT_LOCK_WAIT_MS = 10_000;

/** What the lock file holds, for people and logs looking at a stuck vault. Keys are stored, so snake_case. */
export interface VaultLockRecord {
  pid: number;
  acquired_at: string;
}

/** Thrown when the vault stayed busy for the whole wait. The message is for the person. */
export class VaultBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Memory is busy right now. Try again in a moment.', options);
    this.name = 'VaultBusyError';
  }
}

export interface VaultLockOptions {
  vaultDir: string;
  staleAfterMs?: number | undefined;
  waitMs?: number | undefined;
  /** Clock, for tests. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** Pause between attempts, for tests. Default a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Written into the lock record. Default the current process id. */
  pid?: number | undefined;
}

/**
 * Runs `work` while holding the vault lock, then releases it even when `work` throws.
 *
 * Acquire: create the lock file exclusively (`wx`) holding a `VaultLockRecord`. When it
 * already exists, read it; an unreadable record or one older than `staleAfterMs` is removed
 * and the attempt repeats at once; otherwise wait (25 ms, doubling, at most 250 ms between
 * tries) until `waitMs` has passed, then throw `VaultBusyError`. The state folder is created
 * when missing. The lock is not re-entrant: nested calls on one vault wait like strangers.
 */
export async function withVaultLock<T>(options: VaultLockOptions, work: () => Promise<T>): Promise<T> {
  const lockPath = path.join(options.vaultDir, VAULT_LOCK_FILE);
  const staleAfterMs = options.staleAfterMs ?? VAULT_LOCK_STALE_AFTER_MS;
  const waitMs = options.waitMs ?? VAULT_LOCK_WAIT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pid = options.pid ?? process.pid;

  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = now();
  let delay = 25;

  for (;;) {
    const created = await tryCreateLock({ lockPath, pid, now });
    if (created) {
      break;
    }

    if (await isLockAbandoned({ lockPath, now, staleAfterMs })) {
      await rm(lockPath, { force: true });
      continue;
    }

    if (now() - startedAt >= waitMs) {
      throw new VaultBusyError();
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 250);
  }

  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function tryCreateLock({
  lockPath,
  pid,
  now,
}: {
  lockPath: string;
  pid: number;
  now: () => number;
}): Promise<boolean> {
  const record: VaultLockRecord = { pid, acquired_at: new Date(now()).toISOString() };
  try {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify(record));
    } catch (error) {
      await rm(lockPath, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
  return true;
}

async function isLockAbandoned({
  lockPath,
  now,
  staleAfterMs,
}: {
  lockPath: string;
  now: () => number;
  staleAfterMs: number;
}): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return true;
  }

  const acquiredAt = 'acquired_at' in parsed ? parsed.acquired_at : undefined;
  if (typeof acquiredAt !== 'string') {
    return true;
  }
  const acquiredMs = Date.parse(acquiredAt);
  if (!Number.isFinite(acquiredMs)) {
    return true;
  }

  return now() - acquiredMs > staleAfterMs;
}
