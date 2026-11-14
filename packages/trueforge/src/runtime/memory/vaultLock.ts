/**
 * One lock per vault, shared across processes through files in `.memory-state/`, so the nightly pass
 * and a live chat on another replica never change pages at the same time. It covers `people/`,
 * `matters/`, `.memory-state/` and the page history. Saving a note and erasing deleted text from the dated
 * files take it too, so a rewrite never loses a note saved at the same moment.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

/** The folder the lock files live in, beside the other notes Aman keeps for itself. */
const LOCK_DIR = '.memory-state';

/** The vault's state folder, where the lock and Aman's own small notes about the vault live. */
export function vaultStateDir(vaultDir: string): string {
  return path.join(vaultDir, LOCK_DIR);
}

/** A lock whose holder has shown no sign of life for this long, as the waiter measured it, is taken over. */
export const VAULT_LOCK_STALE_AFTER_MS = 30_000;

/** How long a caller waits for a busy vault before giving up. */
export const VAULT_LOCK_WAIT_MS = 10_000;

/** What a lock file holds, for people and logs looking at a stuck vault. Keys are stored, so snake_case. */
const VaultLockRecordSchema = z.object({
  /** Unique per acquisition, so release can tell whose lock it is looking at. */
  token: z.string().min(1),
  pid: z.number().int(),
  host: z.string(),
  /** The holder's wall clock when it took the lock. Shown to people only, never used to judge staleness. */
  started_at: z.string(),
  /** The file's own number. A lock is replaced only by a file with the next number, which only one caller can create. */
  generation: z.number().int().positive(),
  /** A released lock is a marker that keeps the numbering going, so a slow caller cannot reuse a number. */
  released: z.boolean(),
});
type VaultLockRecord = z.infer<typeof VaultLockRecordSchema>;

/** Thrown when the vault stayed busy for the whole wait. The message is for the person. */
export class VaultBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Memory is busy right now. Try again in a moment.', options);
    this.name = 'VaultBusyError';
  }
}

/** Thrown by `assertHeld` when another writer took the lock over. The message is for the person. */
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
  /** A clock that only moves forward, in milliseconds, for tests. Default `performance.now`. */
  now?: (() => number) | undefined;
  /** Pause between attempts, for tests. Default a real timer. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Who is recorded as the holder, for tests. Default this process. */
  holder?: { pid: number; host: string } | undefined;
  /** Runs the heartbeat, for tests. Default a real interval. */
  schedule?: VaultLockScheduler | undefined;
}

/** The lock as one look at the folder shows it: the highest numbered file. */
interface LockState {
  generation: number;
  record: VaultLockRecord | undefined;
  /** Everything a live holder changes, so an unchanged signature means no sign of life. */
  signature: string;
}

/** What each lock folder looked like last, and when this process first saw it so. Only this process's own clock is used. */
const observations = new Map<string, { signature: string; since: number }>();
const MAX_OBSERVATIONS = 64;

/**
 * Runs `work` while holding the vault lock, then releases it even when `work` throws.
 *
 * Why this is safe between processes:
 * - The lock is the highest numbered file `lock.<n>`. A file is made complete in a temp file and then
 *   `link`ed to its name, so a reader never sees it empty, and `link` fails when the name exists, so
 *   exactly one caller can ever create number `n`.
 * - A lock is replaced only by creating number `n + 1`. That one exclusive create is the claim: two
 *   takers of the same stale lock cannot both win, and a slow taker finds its number already used.
 * - Release creates `n + 1` too, as a "released" marker, but only while `n` is still the highest and
 *   carries this call's token. Numbers never repeat, so a caller that slept through a release and a new
 *   lock cannot create a lock below the current one and be mistaken for the owner; if it does create
 *   one, it sees that it is not the highest and removes it.
 * - The holder rewrites `lock.<n>.beat` every sixth of the stale time. A waiter judges a lock stale
 *   only when nothing about it has changed for the stale time on the waiter's own clock, so a holder
 *   whose wall clock is wrong cannot make a live lock look stale, or a dead one look alive.
 *
 * Callers wait (25 ms, doubling, at most 250 ms between tries) until `waitMs` has passed, then get
 * `VaultBusyError`. What a waiter has seen is remembered between calls, so repeated tries add up to the
 * stale time. The state folder is created when missing. The lock is not re-entrant.
 */
export async function withVaultLock<T>(
  options: VaultLockOptions,
  work: (lock: VaultLockHandle) => Promise<T>,
): Promise<T> {
  const stateDir = vaultStateDir(options.vaultDir);
  const staleAfterMs = options.staleAfterMs ?? VAULT_LOCK_STALE_AFTER_MS;
  const waitMs = options.waitMs ?? VAULT_LOCK_WAIT_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;
  const holder = options.holder ?? { pid: process.pid, host: hostname() };
  const token = randomUUID();

  await mkdir(stateDir, { recursive: true });
  const startedAt = now();
  let delay = 25;
  let generation: number | undefined;
  while (generation === undefined) {
    generation = await tryAcquire({ stateDir, token, holder, now, staleAfterMs });
    if (generation === undefined) {
      if (now() - startedAt >= waitMs) {
        throw new VaultBusyError();
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
  observations.delete(stateDir);

  const heartbeat = startHeartbeat({
    stateDir,
    generation,
    staleAfterMs,
    schedule: options.schedule ?? defaultSchedule,
  });
  try {
    return await work({ assertHeld: heartbeat.assertHeld });
  } finally {
    // The heartbeat stops first so it cannot rewrite the beat while release is clearing it.
    await heartbeat.stop();
    await release({ stateDir, token, generation, holder });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultSchedule(tick: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function lockFile({ stateDir, generation }: { stateDir: string; generation: number }): string {
  return path.join(stateDir, `lock.${String(generation)}`);
}

function beatFile({ stateDir, generation }: { stateDir: string; generation: number }): string {
  return `${lockFile({ stateDir, generation })}.beat`;
}

const LOCK_FILE_PATTERN = /^lock\.(\d+)$/;

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function parseRecord(raw: string): VaultLockRecord | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = VaultLockRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** The generations of the lock files in the folder, highest first. */
async function lockGenerations(stateDir: string): Promise<number[]> {
  const generations = (await readdir(stateDir)).flatMap(name => {
    const digits = LOCK_FILE_PATTERN.exec(name)?.[1];
    return digits === undefined ? [] : [Number(digits)];
  });
  return generations.sort((a, b) => b - a);
}

/** The highest numbered lock, or undefined when there is none. A file removed between the listing and the read is listed again. */
async function readState(stateDir: string): Promise<LockState | undefined> {
  for (;;) {
    const [generation] = await lockGenerations(stateDir);
    if (generation === undefined) {
      return undefined;
    }
    const raw = await readIfPresent(lockFile({ stateDir, generation }));
    if (raw === undefined) {
      continue;
    }
    const beat = (await readIfPresent(beatFile({ stateDir, generation }))) ?? '';
    return { generation, record: parseRecord(raw), signature: `${String(generation)}\n${raw}\n${beat}` };
  }
}

/**
 * Whether this lock has shown no change for the stale time since this process first saw it so. The first look
 * only starts the count. Only `now` is read, never a time the holder wrote.
 */
function judgeStale({
  stateDir,
  state,
  now,
  staleAfterMs,
}: {
  stateDir: string;
  state: LockState;
  now: () => number;
  staleAfterMs: number;
}): boolean {
  const seen = observations.get(stateDir);
  const current = now();
  if (seen?.signature !== state.signature) {
    if (observations.size >= MAX_OBSERVATIONS && !observations.has(stateDir)) {
      const oldest = observations.keys().next().value;
      if (oldest !== undefined) {
        observations.delete(oldest);
      }
    }
    observations.set(stateDir, { signature: state.signature, since: current });
    return false;
  }
  return current - seen.since >= staleAfterMs;
}

/**
 * One try at the lock. Returns the generation won, or undefined when the vault is busy or another caller
 * won the same number.
 */
async function tryAcquire({
  stateDir,
  token,
  holder,
  now,
  staleAfterMs,
}: {
  stateDir: string;
  token: string;
  holder: { pid: number; host: string };
  now: () => number;
  staleAfterMs: number;
}): Promise<number | undefined> {
  const state = await readState(stateDir);
  const free = state === undefined || state.record?.released === true;
  if (!free && !judgeStale({ stateDir, state, now, staleAfterMs })) {
    return undefined;
  }
  const generation = (state?.generation ?? 0) + 1;
  const published = await publish({
    stateDir,
    record: {
      token,
      pid: holder.pid,
      host: holder.host,
      started_at: new Date().toISOString(),
      generation,
      released: false,
    },
  });
  if (!published) {
    return undefined;
  }
  // A caller that slept through a whole release and a new lock may have made a file below the current one.
  const [highest] = await lockGenerations(stateDir);
  if (highest !== generation) {
    await rm(lockFile({ stateDir, generation }), { force: true });
    return undefined;
  }
  await clearBelow({ stateDir, generation });
  return generation;
}

/** Makes the record a complete file and links it to its number. False when the number is taken. */
async function publish({ stateDir, record }: { stateDir: string; record: VaultLockRecord }): Promise<boolean> {
  const temp = path.join(stateDir, `lock.tmp-${record.token}-${String(record.generation)}`);
  try {
    await writeFile(temp, JSON.stringify(record), { flag: 'wx' });
    await link(temp, lockFile({ stateDir, generation: record.generation }));
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Removes every lock file and beat below a generation. Nothing reads them once a higher one exists. */
async function clearBelow({ stateDir, generation }: { stateDir: string; generation: number }): Promise<void> {
  const older = (await lockGenerations(stateDir)).filter(candidate => candidate < generation);
  await Promise.all(
    older.flatMap(candidate => [
      rm(lockFile({ stateDir, generation: candidate }), { force: true }),
      rm(beatFile({ stateDir, generation: candidate }), { force: true }),
    ]),
  );
}

/** Keeps the beat fresh and remembers whether the lock was taken over. Ticks never overlap and never throw. */
function startHeartbeat({
  stateDir,
  generation,
  staleAfterMs,
  schedule,
}: {
  stateDir: string;
  generation: number;
  staleAfterMs: number;
  schedule: VaultLockScheduler;
}): { assertHeld: () => Promise<void>; stop: () => Promise<void> } {
  let lost = false;
  let beats = 0;
  let running: Promise<void> | undefined;

  const isHighest = async (): Promise<boolean> => (await lockGenerations(stateDir))[0] === generation;

  const tick = async (): Promise<void> => {
    if (running !== undefined || lost) {
      return;
    }
    running = (async () => {
      try {
        if (!(await isHighest())) {
          lost = true;
          return;
        }
        beats += 1;
        const target = beatFile({ stateDir, generation });
        const temp = `${target}.tmp`;
        await writeFile(temp, String(beats));
        await rename(temp, target);
      } catch {
        // A beat that could not be written is tried again at the next tick; staleness is judged by others.
      }
    })();
    await running;
    running = undefined;
  };

  const cancel = schedule(tick, Math.max(1, Math.floor(staleAfterMs / 6)));

  return {
    async assertHeld() {
      if (lost || !(await isHighest())) {
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
 * Releases only a lock that still carries our token and is still the highest: it makes the next number a
 * released marker. When a taker already made that number there is nothing of ours left to release.
 */
async function release({
  stateDir,
  token,
  generation,
  holder,
}: {
  stateDir: string;
  token: string;
  generation: number;
  holder: { pid: number; host: string };
}): Promise<void> {
  const raw = await readIfPresent(lockFile({ stateDir, generation }));
  if (raw === undefined || parseRecord(raw)?.token !== token) {
    return;
  }
  const published = await publish({
    stateDir,
    record: {
      token,
      pid: holder.pid,
      host: holder.host,
      started_at: new Date().toISOString(),
      generation: generation + 1,
      released: true,
    },
  });
  if (published) {
    await clearBelow({ stateDir, generation: generation + 1 });
  }
}
