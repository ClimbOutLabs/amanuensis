// Client-supplied idempotency keys for send_email / reply_all.
//
// The failure mode: a send succeeds server-side but the response never
// reaches the caller (client timeout, dropped SSE stream, host crash between
// send and response). A naive retry then delivers the email twice. When the
// caller supplies `idempotencyKey`, the first successful send records
// { messageId, threadId } under the key in <configDir>/idempotency.json
// (24h TTL). A later call with the same key returns the recorded result
// WITHOUT re-sending, after verifying the message still exists
// (reconciliation: a 404 means the record is stale and the send proceeds).
//
// Design notes:
// - Local file, not Gmail-side: Gmail's send endpoint has no idempotency
//   key parameter, and Message-ID is not deduplicated on send. A local
//   dedup record is the only reliable mechanism.
// - Records are scoped to (accountId, key): two accounts reusing the same
//   client key must not see each other's records.
// - Crash window: the record is written as "pending" BEFORE messages.send
//   and carries our own generated RFC822 Message-ID, which is injected into
//   the outgoing message. If the process dies between the send and the
//   confirmation write, the next retry with the same key reconciles by
//   searching Gmail for that Message-ID (rfc822msgid:): found → the send
//   did land, promote to confirmed and replay; not found within the bounded
//   window → the send state is genuinely unknown, so the gate throws
//   (at-most-once) instead of resending and risking a duplicate. The
//   operator retries with a new key for an intentional send, or retries
//   with the same key later once Gmail's index settles (a later search then
//   replays instead of duplicating). Gmail's search index lags a send by
//   seconds, so reconciliation re-searches (bounded, ~30s) before concluding
//   "not found" — a single immediate search can miss a just-sent message
//   and double-send. Residual risk is index lag beyond that bound, which is
//   pathological rather than routine.
// - Concurrency: the check → send → record sequence for one key is
//   serialized by an in-process mutex plus a cross-process lock file
//   (O_EXCL create). A stale lock is broken only when its holder process is
//   demonstrably dead (kill(pid, 0) probe) — a live holder is never evicted,
//   so a slow send can never have its lock stolen. Lock files carry a unique
//   owner token; release unlinks only if the file still holds our token, so
//   a stale-break/reacquire race cannot delete another holder's lock.
// - The store file itself is shared by all keys, so every read-modify-write
//   also takes a store-wide cross-process lock: two processes handling
//   DIFFERENT keys cannot interleave and drop each other's records. Writes
//   are atomic (temp file + rename), so a crash mid-write can only orphan a
//   temp file, never corrupt the store.
// - A corrupt store file fails closed: the send throws rather than
//   proceeding without dedup state (which would risk a duplicate send).

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfigDir } from "./config-paths.js";

/** How long a dedup record lives. 24h covers every realistic retry window. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Bound on stored records so the file can't grow without limit. */
export const IDEMPOTENCY_MAX_ENTRIES = 1000;

/** A lock file older than this is presumed orphaned and broken. */
const LOCK_STALE_MS = 60_000;

/** How long to keep trying to acquire a contested lock. */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

const STORE_FILE = "idempotency.json";

export type IdempotencyStatus = "pending" | "sent";

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  /** Our generated RFC822 Message-ID, injected into the outgoing message. */
  rfc822MessageId: string;
  /** Gmail's message id — present once the send is confirmed. */
  messageId?: string;
  threadId?: string;
  /** Epoch ms when the record was written. */
  createdAt: number;
}

type Store = Record<string, IdempotencyRecord>;

/** Validates untrusted store entries — the file is user-writable. */
const IdempotencyRecordSchema = z.object({
  status: z.union([z.literal("pending"), z.literal("sent")]),
  rfc822MessageId: z.string().min(1),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  createdAt: z.number(),
});

function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), STORE_FILE);
}

/**
 * Namespace the store key by account so two accounts reusing the same
 * client key never see each other's dedup records. JSON-encoding the pair
 * avoids any separator-collision ambiguity.
 */
export function scopedIdempotencyKey(accountId: string, key: string): string {
  return JSON.stringify([accountId, key]);
}

/** Deterministic lock-file name for a scoped key (keys are client-controlled). */
function lockPathFor(scopedKey: string, env: NodeJS.ProcessEnv): string {
  const digest = createHash("sha256").update(scopedKey).digest("hex").slice(0, 16);
  return path.join(getConfigDir(env), `idempotency-${digest}.lock`);
}

/** Store-wide lock: serializes read-modify-write across processes sharing the config dir. */
function storeLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(getConfigDir(env), "idempotency-store.lock");
}

/** Generate a unique RFC822 Message-ID for crash-window reconciliation. */
export function generateRfc822MessageId(): string {
  return `<${randomUUID()}@gmail-mcp>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Narrow an unknown throw to Node's EEXIST without a cast. */
function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "EEXIST"
  );
}

// In-process mutex, composed with a cross-process store-wide file lock:
// serialize store access so concurrent sends — in this process AND in a
// second process sharing the config dir (stdio + HTTP) — can't interleave
// read-modify-write and drop records. Lock order is always per-key lock
// (withIdempotencyKeyLock) → store lock; nothing ever takes them in the
// opposite order, so no deadlock.
let storeMutex: Promise<void> = Promise.resolve();

async function withStoreLock<T>(
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const run = storeMutex.then(() => withFileLock(storeLockPath(env), fn));
  // The lock itself must never stay rejected — swallow so the next waiter
  // still runs. The caller's error still propagates via `run`.
  storeMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Cross-process mutex for one idempotency key. Creates the lock file with
 * O_EXCL; the file content is a unique owner token
 * `<pid>:<epochMs>:<uuid>` written by the holder.
 *
 * Stale-lock policy: a lock is broken only when it is older than
 * LOCK_STALE_MS **and** its holder pid no longer exists (kill(pid, 0)
 * probe). A live holder is never evicted — even a very slow send keeps its
 * lock; waiters time out (fail closed) instead of stealing it. A lock whose
 * content is unparseable is treated as orphaned once it passes the age
 * threshold.
 *
 * Release is ownership-checked: the file is unlinked only if it still
 * contains our token, so a stale-break/reacquire race can never delete a
 * newer holder's lock.
 */
async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(token);
    } catch (err) {
      // If the open succeeded but the token write failed, close the handle
      // and retry: otherwise we leak an fd and leave a partial lock file
      // that a later waiter must age out.
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        handle = undefined;
      }
      if (!isEexistError(err)) throw err;
      if (await tryBreakStaleLock(lockPath)) continue; // orphaned — retry immediately
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring idempotency lock for ${path.basename(lockPath)}`, {
          cause: err,
        });
      }
      await sleep(50 + Math.random() * 100);
      handle = undefined;
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    // Ownership-checked release: only unlink if the lock is still ours.
    try {
      const current = await fs.readFile(lockPath, "utf8");
      if (current === token) await fs.unlink(lockPath);
    } catch {
      /* ignore — already gone or unreadable; never unlink blindly */
    }
  }
}

/** Holder pid parsed from a lock file's `<pid>:<epochMs>:<uuid>` content. */
function lockHolderPid(content: string): number | undefined {
  const match = /^(\d+):/.exec(content.trim());
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** True when the pid exists (any signal-permission state counts as alive). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we may not signal it.
    // Anything else (or an unshaped error) assumes alive — fail closed, so a
    // lock is only ever broken for a provably-dead holder.
    if (err instanceof Error && "code" in err) {
      return err.code !== "ESRCH";
    }
    return true;
  }
}

/**
 * The stale-lock policy as a pure predicate of (lock mtime, lock content,
 * now): a lock is breakable only when it is older than LOCK_STALE_MS and
 * its holder is demonstrably dead (kill(pid, 0) probe fails with ESRCH) or
 * its content is unparseable. A live holder is never evicted, whatever the
 * age. Exported so the policy is unit-testable without filesystem timing
 * games; breaking itself stays internal to withFileLock.
 */
export function shouldBreakStaleLock(
  lockMtimeMs: number,
  lockContent: string,
  nowMs: number = Date.now(),
): boolean {
  if (nowMs - lockMtimeMs <= LOCK_STALE_MS) return false;
  const pid = lockHolderPid(lockContent);
  if (pid !== undefined && isPidAlive(pid)) return false; // live holder — never evict
  return true;
}

/**
 * Break a lock file only when it is provably orphaned (see
 * shouldBreakStaleLock). Returns true when the lock was removed and the
 * caller should retry acquisition immediately.
 */
async function tryBreakStaleLock(lockPath: string): Promise<boolean> {
  const pair = await Promise.all([
    fs.stat(lockPath),
    fs.readFile(lockPath, "utf8"),
  ]).catch(() => null);
  if (pair === null) return true; // raced with a release — the path is free now
  const [stat, content] = pair;
  if (!shouldBreakStaleLock(stat.mtimeMs, content)) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false; // someone else broke or released it; keep waiting
  }
}

/**
 * Per-key async mutex. Serializes the whole check → send → record sequence
 * for one idempotency key so two concurrent sends carrying the same key
 * cannot both pass the lookup and double-send. Combines an in-process mutex
 * with the cross-process file lock above, so the guarantee holds across
 * two server processes sharing a config dir (stdio + HTTP).
 */
const keyTails = new Map<string, Promise<void>>();

export async function withIdempotencyKeyLock<T>(
  accountId: string,
  key: string,
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const scoped = scopedIdempotencyKey(accountId, key);
  const prevTail = keyTails.get(scoped) ?? Promise.resolve();
  // The Promise executor runs synchronously, so `release` is always set
  // before the tail can be observed — the optional call is purely for the
  // type-checker (no empty-function initializer, no non-null assertion).
  let release: (() => void) | undefined;
  const myTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The new tail resolves only after the previous holder released AND we
  // release, so waiters queue strictly in arrival order.
  const newTail = prevTail.then(() => myTurn);
  keyTails.set(scoped, newTail);
  // A previous holder's failure must not wedge the chain — its finally
  // still released us, so we proceed regardless.
  await prevTail.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await withFileLock(lockPathFor(scoped, env), fn);
  } finally {
    release?.();
    if (keyTails.get(scoped) === newTail) keyTails.delete(scoped);
  }
}

/**
 * Read the store. A missing file means no records yet. A corrupt file is
 * FAIL-CLOSED: proceeding without dedup state could double-send, so the
 * send throws with a repair hint instead of silently starting fresh.
 */
async function readStore(env: NodeJS.ProcessEnv): Promise<Store> {
  const file = storePath(env);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {}; // missing file → no records yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `Idempotency store is corrupt (${file}): not valid JSON. ` +
        `Refusing to send without dedup state — repair or remove the file, ` +
        `or retry with a different idempotency key.`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Idempotency store is corrupt (${file}): expected a JSON object. ` +
        `Refusing to send without dedup state — repair or remove the file, ` +
        `or retry with a different idempotency key.`,
    );
  }
  // Validate each entry: the store file is user-writable, never trust it.
  const store: Store = {};
  for (const [key, value] of Object.entries(parsed)) {
    const record = IdempotencyRecordSchema.safeParse(value);
    if (record.success) store[key] = record.data;
  }
  return store;
}

function isLiveRecord(value: unknown): value is IdempotencyRecord {
  const record = IdempotencyRecordSchema.safeParse(value);
  return (
    record.success && Date.now() - record.data.createdAt < IDEMPOTENCY_TTL_MS
  );
}

function prune(store: Store): Store {
  const pruned: Store = {};
  for (const [key, value] of Object.entries(store)) {
    if (isLiveRecord(value)) pruned[key] = value;
  }
  // Bound growth: drop the oldest records first — but never evict PENDING
  // records to enforce the cap. A pending record is an in-flight send;
  // dropping it would let a later retry miss its dedup state and
  // double-send. (Pending records still expire via the TTL above.)
  const keys = Object.keys(pruned);
  if (keys.length > IDEMPOTENCY_MAX_ENTRIES) {
    const evictable = keys
      .filter((k) => pruned[k].status !== "pending")
      .sort((a, b) => pruned[a].createdAt - pruned[b].createdAt);
    for (const key of evictable.slice(0, keys.length - IDEMPOTENCY_MAX_ENTRIES)) {
      delete pruned[key];
    }
  }
  return pruned;
}

async function writeStore(env: NodeJS.ProcessEnv, store: Store): Promise<void> {
  const file = storePath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write: a crash between write and rename orphans the temp file
  // but can never leave a half-written store behind.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

async function upsertRecord(
  accountId: string,
  key: string,
  record: IdempotencyRecord,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await withStoreLock(async () => {
    const store = await readStore(env);
    store[scopedIdempotencyKey(accountId, key)] = record;
    // Prune AFTER the mutation so the written file never exceeds the cap.
    await writeStore(env, prune(store));
  }, env);
}

/**
 * Look up a live dedup record for (accountId, key). Returns undefined when
 * no record exists or the record expired (expired records are pruned
 * lazily here).
 */
export async function lookupIdempotencyKey(
  accountId: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IdempotencyRecord | undefined> {
  return withStoreLock(async () => prune(await readStore(env))[scopedIdempotencyKey(accountId, key)], env);
}

/**
 * Record a send intent BEFORE messages.send. Carries our generated
 * RFC822 Message-ID so a crash between the send and the confirmation
 * write can be reconciled by searching Gmail for that Message-ID.
 */
export async function recordPendingSend(
  accountId: string,
  key: string,
  rfc822MessageId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await upsertRecord(
    accountId,
    key,
    { status: "pending", rfc822MessageId, createdAt: Date.now() },
    env,
  );
}

/**
 * Confirm a successful send, overwriting the pending intent record.
 */
export async function recordConfirmedSend(
  accountId: string,
  key: string,
  record: { messageId: string; threadId?: string; rfc822MessageId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const entry: IdempotencyRecord = {
    status: "sent",
    rfc822MessageId: record.rfc822MessageId,
    messageId: record.messageId,
    createdAt: Date.now(),
  };
  if (record.threadId !== undefined) entry.threadId = record.threadId;
  await upsertRecord(accountId, key, entry, env);
}

/**
 * Drop the dedup record for (accountId, key) — used when reconciliation
 * shows the recorded message never landed or no longer exists.
 */
export async function forgetIdempotencyKey(
  accountId: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withStoreLock(async () => {
    const store = prune(await readStore(env));
    const scoped = scopedIdempotencyKey(accountId, key);
    if (!(scoped in store)) return;
    delete store[scoped];
    await writeStore(env, store);
  }, env);
}
