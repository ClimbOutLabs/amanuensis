/**
 * One lock per vault, shared across processes through a lock file, so the nightly pass in the
 * controller and a live chat on a server replica never write pages at the same time. Held
 * only around page writes and git calls; the daily log append path never takes it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/** The lock file, inside the state folder so git and export never see it. */
export const VAULT_LOCK_FILE = path.join('.memory-state', 'lock');

/** A lock not renewed for this long is judged abandoned (a crashed holder) and taken over. */
export const VAULT_LOCK_STALE_AFTER_MS = 60_000;

/** How long a caller waits for a busy vault before giving up. */
export const VAULT_LOCK_WAIT_MS = 10_000;

/** What the lock file holds, for people and logs looking at a stuck vault. Keys are stored, so snake_case. */
export const VaultLockRecordSchema = z.object({
  pid: z.number().int(),
  acquired_at: z.string(),
  /** Unique per acquisition, so release and takeover can tell whose lock they are looking at. */
  token: z.string().min(1),
});
export type VaultLockRecord = z.infer<typeof VaultLockRecordSchema>;

/** Thrown when the vault stayed busy for the whole wait. The message is for the person. */
export class VaultBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Memory is busy right now. Try again in a moment.', options);
    this.name = 'VaultBusyError';
  }
}

/** Thrown by `assertHeld` when the lock was taken over or could not be kept. The message is for the person. */
export class VaultLockLostError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Memory was busy for too long and another writer took over. Nothing more was saved. Try again.', options);
    this.name = 'VaultLockLostError';
  }
}

/** Passed to the work so it can check, before each write, that it still owns the vault. */
export interface VaultLockHandle {
  /** Resolves while this call still holds the lock; throws `VaultLockLostError` once it does not. */
  assertHeld(): Promise<void>;
}

/** Starts calling `tick` every `intervalMs` and returns a function that stops it. `tick` never rejects. */
export type VaultLockScheduler = (tick: () => Promise<void>, intervalMs: number) => () => void;

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
  /** Runs the renewal ticks, for tests. Default a real interval. */
  schedule?: VaultLockScheduler | undefined;
}

/**
 * Runs `work` while holding the vault lock, then releases it even when `work` throws.
 *
 * Why this is safe between processes:
 * - Publish: the record is written to a private temp file, then `link`ed to the lock path.
 *   `link` fails if the path exists, so exactly one caller wins and the lock path never shows
 *   partial content.
 * - Stale takeover: the taker first claims `<lock>.takeover-<identity of the stale lock>-<n>`
 *   (exclusive create; a claim left by a crashed taker is never deleted, later callers move to
 *   the next generation once it is stale), re-reads the lock under that claim, and only if it is still the same
 *   stale lock replaces it with one atomic `rename`. Releasing takes the same claim, so a
 *   release and a takeover of one lock can never interleave, and a second taker who judged the
 *   same lock stale finds a different lock once it gets the claim and backs off.
 * - A lock whose file cannot be read as a record (empty, partial, foreign) is only stale by the
 *   file's age, never at once.
 * - Renewal: while `work` runs, the holder rewrites the record with a fresh `acquired_at` every
 *   quarter of the stale age, under the same claim as release, so a working holder is never
 *   judged abandoned and a renewal cannot interleave with a takeover. A renewal that finds
 *   another token marks the lock lost; `assertHeld` on the handle given to `work` then throws
 *   `VaultLockLostError`, so work with several slow steps can stop before writing again.
 * - Release removes the lock only when it still carries this call's token.
 *
 * Callers wait (25 ms, doubling, at most 250 ms between tries) until `waitMs` has passed, then
 * get `VaultBusyError`. The state folder is created when missing. The lock is not re-entrant:
 * nested calls on one vault wait like strangers.
 */
export async function withVaultLock<T>(
  options: VaultLockOptions,
  work: (lock: VaultLockHandle) => Promise<T>,
): Promise<T> {
  const lockPath = path.join(options.vaultDir, VAULT_LOCK_FILE);
  const staleAfterMs = options.staleAfterMs ?? VAULT_LOCK_STALE_AFTER_MS;
  const waitMs = options.waitMs ?? VAULT_LOCK_WAIT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pid = options.pid ?? process.pid;
  const token = randomUUID();
  const tempPath = `${lockPath}.${token}.tmp`;

  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = now();
  let delay = 25;

  try {
    for (;;) {
      const record: VaultLockRecord = { pid, acquired_at: new Date(now()).toISOString(), token };
      await writeFile(tempPath, JSON.stringify(record));
      if (await tryPublish({ tempPath, lockPath })) {
        break;
      }
      if (await tryTakeOver({ tempPath, lockPath, now, staleAfterMs })) {
        break;
      }
      if (now() - startedAt >= waitMs) {
        throw new VaultBusyError();
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  } finally {
    await rm(tempPath, { force: true });
  }

  const renewal = startRenewal({
    lockPath,
    token,
    pid,
    now,
    staleAfterMs,
    schedule: options.schedule ?? defaultSchedule,
  });
  try {
    return await work({ assertHeld: renewal.assertHeld });
  } finally {
    // Renewal stops first so it cannot rewrite the record while release is removing it.
    await renewal.stop();
    await release({ lockPath, token, now, staleAfterMs });
  }
}

function defaultSchedule(tick: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

/** Keeps the record fresh and remembers whether the lock was lost. Ticks never overlap and never throw. */
function startRenewal({
  lockPath,
  token,
  pid,
  now,
  staleAfterMs,
  schedule,
}: {
  lockPath: string;
  token: string;
  pid: number;
  now: () => number;
  staleAfterMs: number;
  schedule: VaultLockScheduler;
}): { assertHeld: () => Promise<void>; stop: () => Promise<void> } {
  let lost = false;
  let failure: { error: unknown } | undefined;
  let running: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    if (running !== undefined || lost) {
      return;
    }
    running = (async () => {
      try {
        const outcome = await renew({ lockPath, token, pid, now, staleAfterMs });
        lost = outcome === 'lost';
        failure = undefined;
      } catch (error) {
        failure = { error };
      }
    })();
    await running;
    running = undefined;
  };

  const cancel = schedule(tick, Math.max(1, Math.floor(staleAfterMs / 4)));

  return {
    async assertHeld() {
      if (lost) {
        throw new VaultLockLostError();
      }
      if (failure !== undefined) {
        throw new VaultLockLostError({ cause: failure.error });
      }
      let raw: string;
      try {
        raw = await readFile(lockPath, 'utf8');
      } catch (error) {
        lost = hasErrorCode(error, 'ENOENT');
        throw new VaultLockLostError({ cause: error });
      }
      if (parseRecord(raw)?.token !== token) {
        lost = true;
        throw new VaultLockLostError();
      }
    },
    async stop() {
      cancel();
      await running;
    },
  };
}

/**
 * Rewrites our record with a fresh `acquired_at`. `skipped` when a taker holds the claim on our
 * token (the next tick sees the outcome), `lost` when the lock now carries another token.
 */
async function renew({
  lockPath,
  token,
  pid,
  now,
  staleAfterMs,
}: {
  lockPath: string;
  token: string;
  pid: number;
  now: () => number;
  staleAfterMs: number;
}): Promise<'renewed' | 'skipped' | 'lost'> {
  const claimPath = await tryClaim({ lockPath, identity: token, now, staleAfterMs });
  if (claimPath === undefined) {
    return 'skipped';
  }
  const tempPath = `${lockPath}.${token}.renew`;
  try {
    let raw: string;
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return 'lost';
      }
      throw error;
    }
    if (parseRecord(raw)?.token !== token) {
      return 'lost';
    }
    const record: VaultLockRecord = { pid, acquired_at: new Date(now()).toISOString(), token };
    await writeFile(tempPath, JSON.stringify(record));
    await rename(tempPath, lockPath);
    return 'renewed';
  } finally {
    await rm(tempPath, { force: true });
    await rm(claimPath, { force: true });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Puts the finished temp record at the lock path. False when the path is already taken. */
async function tryPublish({ tempPath, lockPath }: { tempPath: string; lockPath: string }): Promise<boolean> {
  try {
    await link(tempPath, lockPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

interface LockInspection {
  /** The token for a readable record, else a hash of the raw bytes. Names the claim file. */
  identity: string;
  stale: boolean;
}

/** Reads the lock and judges it. Null when no lock file exists. */
async function inspectLock({
  lockPath,
  now,
  staleAfterMs,
}: {
  lockPath: string;
  now: () => number;
  staleAfterMs: number;
}): Promise<LockInspection | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await readFile(lockPath, 'utf8');
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  const record = parseRecord(raw);
  if (record === null) {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return { identity: `raw-${digest}`, stale: now() - mtimeMs > staleAfterMs };
  }
  return { identity: record.token, stale: now() - Date.parse(record.acquired_at) > staleAfterMs };
}

function parseRecord(raw: string): VaultLockRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = VaultLockRecordSchema.safeParse(json);
  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.acquired_at))) {
    return null;
  }
  return parsed.data;
}

/**
 * Replaces a stale lock with the temp record. False when the lock is not stale, is gone, was
 * replaced by someone else, or another caller is already taking it over.
 */
async function tryTakeOver({
  tempPath,
  lockPath,
  now,
  staleAfterMs,
}: {
  tempPath: string;
  lockPath: string;
  now: () => number;
  staleAfterMs: number;
}): Promise<boolean> {
  const judged = await inspectLock({ lockPath, now, staleAfterMs });
  if (!judged?.stale) {
    return false;
  }

  const claimPath = await tryClaim({ lockPath, identity: judged.identity, now, staleAfterMs });
  if (claimPath === undefined) {
    return false;
  }
  let replaced = false;
  try {
    const confirmed = await inspectLock({ lockPath, now, staleAfterMs });
    if (!confirmed?.stale || confirmed.identity !== judged.identity) {
      return false;
    }
    await rename(tempPath, lockPath);
    replaced = true;
    return true;
  } finally {
    // Once the stale lock is gone its identity is never seen again, so every claim on it, including
    // ones left by a crashed taker, is garbage. A late taker that claims it anyway re-reads the lock,
    // finds another identity and backs off.
    await (replaced ? removeClaims({ lockPath, identity: judged.identity }) : rm(claimPath, { force: true }));
  }
}

/** The claim file for one lock identity at one generation. */
function claimFile({
  lockPath,
  identity,
  generation,
}: {
  lockPath: string;
  identity: string;
  generation: number;
}): string {
  return `${lockPath}.takeover-${identity}-${String(generation)}`;
}

/** Claims are never cleared by age, so a caller that crashes holding one can only ever add generations. */
const MAX_CLAIM_GENERATIONS = 64;

/**
 * Takes the claim on a lock identity and returns its path, or undefined when someone else holds it.
 * Claims are created exclusively, generation 1 first. A claim left by a crashed caller is never
 * deleted to make room (two callers deleting and recreating one stale claim could each think they
 * won); instead, once a generation's claim is older than `staleAfterMs`, callers move on to the next
 * generation, which again only one of them can create.
 */
async function tryClaim({
  lockPath,
  identity,
  now,
  staleAfterMs,
}: {
  lockPath: string;
  identity: string;
  now: () => number;
  staleAfterMs: number;
}): Promise<string | undefined> {
  for (let generation = 1; generation <= MAX_CLAIM_GENERATIONS; generation += 1) {
    const claimPath = claimFile({ lockPath, identity, generation });
    try {
      await writeFile(claimPath, '', { flag: 'wx' });
      return claimPath;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(claimPath)).mtimeMs;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        // Its holder just finished; the lock has moved on, so there is nothing to claim now.
        return undefined;
      }
      throw error;
    }
    if (now() - mtimeMs <= staleAfterMs) {
      return undefined;
    }
  }
  return undefined;
}

/** Removes every claim on one lock identity. Called once that identity can no longer be the lock. */
async function removeClaims({ lockPath, identity }: { lockPath: string; identity: string }): Promise<void> {
  const prefix = `${path.basename(lockPath)}.takeover-${identity}-`;
  const names = await readdir(path.dirname(lockPath));
  await Promise.all(
    names
      .filter(name => name.startsWith(prefix))
      .map(name => rm(path.join(path.dirname(lockPath), name), { force: true })),
  );
}

/**
 * Removes the lock only while it still carries our token. The takeover claim for our token is
 * held meanwhile, so nobody can replace the lock between the check and the removal; when the
 * claim is already taken, a taker is replacing our lock and there is nothing of ours to remove.
 */
async function release({
  lockPath,
  token,
  now,
  staleAfterMs,
}: {
  lockPath: string;
  token: string;
  now: () => number;
  staleAfterMs: number;
}): Promise<void> {
  const claimPath = await tryClaim({ lockPath, identity: token, now, staleAfterMs });
  if (claimPath === undefined) {
    return;
  }
  let removed = false;
  try {
    let raw: string;
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    if (parseRecord(raw)?.token === token) {
      await rm(lockPath, { force: true });
      removed = true;
    }
  } finally {
    await (removed ? removeClaims({ lockPath, identity: token }) : rm(claimPath, { force: true }));
  }
}
