// Unit tests for the idempotency-key dedup store (core/idempotency.ts).
//
// The store is a small JSON file under the configured GMAIL_CONFIG_DIR.
// Tests pass an explicit env so they never touch the real config dir.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetIdempotencyKey,
  generateRfc822MessageId,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  lookupIdempotencyKey,
  recordConfirmedSend,
  recordPendingSend,
  scopedIdempotencyKey,
  shouldBreakStaleLock,
  withIdempotencyKeyLock,
} from "../../src/core/idempotency.js";

const dirs: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const dir = path.join(
    tmpdir(),
    `gmail-idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dirs.push(dir);
  return { ...process.env, GMAIL_CONFIG_DIR: dir };
}

/** Mirror of the module's private lockPathFor — derived from public inputs only. */
function lockPathFor(scopedKey: string, env: NodeJS.ProcessEnv): string {
  const dir = env.GMAIL_CONFIG_DIR;
  if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
  const digest = createHash("sha256").update(scopedKey).digest("hex").slice(0, 16);
  return path.join(dir, `idempotency-${digest}.lock`);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("idempotency store", () => {
  it("records a pending intent and confirms it after the send", async () => {
    const env = testEnv();
    const rfcId = generateRfc822MessageId();
    expect(await lookupIdempotencyKey("work", "k1", env)).toBeUndefined();
    await recordPendingSend("work", "k1", rfcId, env);
    const pending = await lookupIdempotencyKey("work", "k1", env);
    expect(pending?.status).toBe("pending");
    expect(pending?.rfc822MessageId).toBe(rfcId);
    expect(pending?.messageId).toBeUndefined();

    await recordConfirmedSend(
      "work",
      "k1",
      { messageId: "msg-1", threadId: "thr-1", rfc822MessageId: rfcId },
      env,
    );
    const confirmed = await lookupIdempotencyKey("work", "k1", env);
    expect(confirmed?.status).toBe("sent");
    expect(confirmed?.messageId).toBe("msg-1");
    expect(confirmed?.threadId).toBe("thr-1");
    expect(typeof confirmed?.createdAt).toBe("number");
  });

  it("isolates the same client key across accounts", async () => {
    const env = testEnv();
    await recordConfirmedSend(
      "work",
      "shared-key",
      { messageId: "work-msg", rfc822MessageId: generateRfc822MessageId() },
      env,
    );
    await recordConfirmedSend(
      "personal",
      "shared-key",
      { messageId: "personal-msg", rfc822MessageId: generateRfc822MessageId() },
      env,
    );
    expect((await lookupIdempotencyKey("work", "shared-key", env))?.messageId).toBe("work-msg");
    expect((await lookupIdempotencyKey("personal", "shared-key", env))?.messageId).toBe(
      "personal-msg",
    );
    expect(await lookupIdempotencyKey("ghost", "shared-key", env)).toBeUndefined();
  });

  it("scopes keys unambiguously (no separator collisions)", async () => {
    // '["a::b","c"]' must differ from '["a","b::c"]'.
    expect(scopedIdempotencyKey("a::b", "c")).not.toBe(scopedIdempotencyKey("a", "b::c"));
    expect(scopedIdempotencyKey("a", "b")).toBe(scopedIdempotencyKey("a", "b"));
  });

  it("overwrites an existing record", async () => {
    const env = testEnv();
    await recordConfirmedSend(
      "work",
      "k",
      { messageId: "old", rfc822MessageId: generateRfc822MessageId() },
      env,
    );
    await recordConfirmedSend(
      "work",
      "k",
      { messageId: "new", rfc822MessageId: generateRfc822MessageId() },
      env,
    );
    expect((await lookupIdempotencyKey("work", "k", env))?.messageId).toBe("new");
  });

  it("expires records older than the TTL", async () => {
    const env = testEnv();
    const dir = env.GMAIL_CONFIG_DIR;
    if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
    await fs.mkdir(dir, { recursive: true });
    const stale = {
      [scopedIdempotencyKey("work", "old")]: {
        status: "pending",
        rfc822MessageId: "<stale@test>",
        createdAt: Date.now() - IDEMPOTENCY_TTL_MS - 1000,
      },
    };
    await fs.writeFile(path.join(dir, "idempotency.json"), JSON.stringify(stale));
    expect(await lookupIdempotencyKey("work", "old", env)).toBeUndefined();
  });

  it("forgets a record", async () => {
    const env = testEnv();
    await recordPendingSend("work", "k", generateRfc822MessageId(), env);
    await forgetIdempotencyKey("work", "k", env);
    expect(await lookupIdempotencyKey("work", "k", env)).toBeUndefined();
    // Forgetting a missing key is a no-op, not an error.
    await forgetIdempotencyKey("work", "k", env);
    // Forgetting one account's record leaves the other's intact.
    await recordPendingSend("work", "k", generateRfc822MessageId(), env);
    await forgetIdempotencyKey("personal", "k", env);
    expect(await lookupIdempotencyKey("work", "k", env)).not.toBeUndefined();
  });

  it("fails closed on a corrupt store file (never silently drops dedup state)", async () => {
    const env = testEnv();
    const dir = env.GMAIL_CONFIG_DIR;
    if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "idempotency.json"), "not json{{{");
    // A corrupt store must NOT read as empty: that would let a retry miss
    // its pending record and double-send. The send fails with a repair hint.
    await expect(lookupIdempotencyKey("work", "k", env)).rejects.toThrow(
      /Idempotency store is corrupt/,
    );
    await expect(
      recordPendingSend("work", "k", generateRfc822MessageId(), env),
    ).rejects.toThrow(/Idempotency store is corrupt/);
    // A missing store file is still fine — it just means no records yet.
    await fs.rm(path.join(dir, "idempotency.json"));
    expect(await lookupIdempotencyKey("work", "k", env)).toBeUndefined();
    await recordPendingSend("work", "k", generateRfc822MessageId(), env);
    expect(await lookupIdempotencyKey("work", "k", env)).not.toBeUndefined();
  });

  it("serializes concurrent records without losing any", async () => {
    const env = testEnv();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        recordConfirmedSend(
          "work",
          `k${i}`,
          { messageId: `m${i}`, rfc822MessageId: generateRfc822MessageId() },
          env,
        ),
      ),
    );
    for (let i = 0; i < 20; i += 1) {
      expect((await lookupIdempotencyKey("work", `k${i}`, env))?.messageId).toBe(`m${i}`);
    }
  });

  it("serializes the check → send → record sequence per key (no double-send)", async () => {
    const env = testEnv();
    const order: string[] = [];
    const slowSend = async (name: string) => {
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:exit`);
    };
    await Promise.all([
      withIdempotencyKeyLock("work", "k", () => slowSend("a"), env),
      withIdempotencyKeyLock("work", "k", () => slowSend("b"), env),
    ]);
    expect(order).toEqual(["a:enter", "a:exit", "b:enter", "b:exit"]);
  });

  it("does not serialize different keys against each other", async () => {
    const env = testEnv();
    const order: string[] = [];
    const slowSend = async (name: string) => {
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:exit`);
    };
    await Promise.all([
      withIdempotencyKeyLock("work", "k1", () => slowSend("a"), env),
      withIdempotencyKeyLock("work", "k2", () => slowSend("b"), env),
    ]);
    // Both entered before either exited → they ran concurrently.
    expect(order.slice(0, 2)).toEqual(["a:enter", "b:enter"]);
  });

  it("breaks a stale cross-process lock file instead of deadlocking", async () => {
    const env = testEnv();
    const dir = env.GMAIL_CONFIG_DIR;
    if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
    await fs.mkdir(dir, { recursive: true });
    const digest = createHash("sha256")
      .update(scopedIdempotencyKey("work", "stale-key"))
      .digest("hex")
      .slice(0, 16);
    const lockPath = path.join(dir, `idempotency-${digest}.lock`);
    await fs.writeFile(lockPath, "99999:0");
    const ancient = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, ancient, ancient);

    let ran = false;
    await withIdempotencyKeyLock(
      "work",
      "stale-key",
      async () => {
        ran = true;
      },
      env,
    );
    expect(ran).toBe(true);
  });

  it("generates unique, well-formed RFC822 Message-IDs", async () => {
    const a = generateRfc822MessageId();
    const b = generateRfc822MessageId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^<[^<>\s]+@gmail-mcp>$/);
  });

  it("never evicts a stale lock whose holder process is still alive", async () => {
    // Our own pid is definitionally alive; age past the stale threshold.
    const content = `${process.pid}:${Date.now() - 3_600_000}:test-uuid`;
    expect(shouldBreakStaleLock(Date.now() - 120_000, content)).toBe(false);
    // Even a very old lock is safe while its holder lives.
    expect(shouldBreakStaleLock(Date.now() - 3_600_000, content)).toBe(false);
  });

  it("breaks a stale lock whose holder process is dead", async () => {
    // Pid 99999 does not exist in any realistic test environment.
    const content = `99999:${Date.now() - 3_600_000}:test-uuid`;
    expect(shouldBreakStaleLock(Date.now() - 120_000, content)).toBe(true);
  });

  it("does not break a fresh lock even when the holder pid is dead", async () => {
    const content = `99999:${Date.now()}:test-uuid`;
    expect(shouldBreakStaleLock(Date.now(), content)).toBe(false);
  });

  it("breaks an aged lock with unparseable content, but not a fresh one", async () => {
    expect(shouldBreakStaleLock(Date.now() - 120_000, "garbage")).toBe(true);
    expect(shouldBreakStaleLock(Date.now(), "garbage")).toBe(false);
  });

  it("releases its own lock normally", async () => {
    const env = testEnv();
    const lockPath = lockPathFor(scopedIdempotencyKey("work", "own-key"), env);
    await withIdempotencyKeyLock("work", "own-key", async () => {}, env);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("does not delete another holder's lock on release (ownership-checked)", async () => {
    const env = testEnv();
    const lockPath = lockPathFor(scopedIdempotencyKey("work", "raced-key"), env);
    await withIdempotencyKeyLock(
      "work",
      "raced-key",
      async () => {
        // Simulate a stale-break/reacquire race: another process stole the
        // lock mid-hold. Our release must not delete their file.
        await fs.writeFile(lockPath, "intruder-token");
      },
      env,
    );
    expect(await fs.readFile(lockPath, "utf8")).toBe("intruder-token");
  });

  it(
    "never evicts a lock held by a live process across a real process boundary",
    async () => {
    const env = testEnv();
    const dir = env.GMAIL_CONFIG_DIR;
    if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
    await fs.mkdir(dir, { recursive: true });
    const lockPath = lockPathFor(scopedIdempotencyKey("work", "xproc-key"), env);

    // Child process: acquires the ("work","xproc-key") lock and holds it.
    const childScript = path.join(dir, "lock-holder.mjs");
    const idemUrl = new URL("../../src/core/idempotency.ts", import.meta.url).href;
    await fs.writeFile(
      childScript,
      [
        `import { withIdempotencyKeyLock } from ${JSON.stringify(idemUrl)};`,
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
        `await withIdempotencyKeyLock("work", "xproc-key", async () => {`,
        `  console.log("LOCKED");`,
        `  await sleep(60000);`,
        `}, process.env);`,
      ].join("\n"),
    );
    const { spawn } = await import("node:child_process");
    const tsxBin = path.resolve("node_modules", ".bin", "tsx");
    const child = spawn(tsxBin, [childScript], {
      env: { ...process.env, GMAIL_CONFIG_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: tsx is a shell wrapper, so the real lock holder
      // (node) is a grandchild. Killing only the wrapper would orphan it
      // and it would keep holding the lock.
      detached: true,
    });
    try {
      // Wait until the child actually holds the lock.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never locked")), 30_000);
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("LOCKED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
      });

      // Age the file past the stale threshold: the live holder must still
      // win — check the real file's mtime/content against the policy.
      const ancient = new Date(Date.now() - 120_000);
      await fs.utimes(lockPath, ancient, ancient);
      const stat = await fs.stat(lockPath);
      const content = await fs.readFile(lockPath, "utf8");
      expect(shouldBreakStaleLock(stat.mtimeMs, content)).toBe(false);
      // Well-formed owner token from the (live) child process.
      expect(content.trim()).toMatch(/^\d+:\d+:[0-9a-f-]{36}$/);
    } finally {
      // Kill the entire process group so the node grandchild (the actual
      // lock holder behind the tsx shell wrapper) dies too.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }

    // Holder now dead and the file still aged: the orphan IS breakable —
    // acquisition proceeds promptly instead of deadlocking.
    const ancient = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, ancient, ancient).catch(() => undefined);
    let ran = false;
    await withIdempotencyKeyLock("work", "xproc-key", async () => {
      ran = true;
    }, env);
    expect(ran).toBe(true);
    },
    60_000,
  );

  it(
    "does not lose records when two processes write different keys concurrently",
    async () => {
      // Regression test for the shared-store race: per-key lock files
      // serialize one key, but the store file is shared by all keys, so two
      // processes writing DIFFERENT keys used to interleave read-modify-write
      // and silently drop records. The store-wide file lock must serialize
      // them. (Without the fix this fails probabilistically — the race
      // window is small but 180 rapid writes across two processes hit it in
      // practice; with the fix it passes deterministically.)
      const env = testEnv();
      const dir = env.GMAIL_CONFIG_DIR;
      if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
      await fs.mkdir(dir, { recursive: true });

      const idemUrl = new URL("../../src/core/idempotency.ts", import.meta.url).href;
      const workerScript = path.join(dir, "store-race-worker.mjs");
      await fs.writeFile(
        workerScript,
        [
          `import { recordConfirmedSend, generateRfc822MessageId } from ${JSON.stringify(idemUrl)};`,
          `const worker = process.argv[2];`,
          `const count = Number(process.argv[3]);`,
          `for (let i = 0; i < count; i++) {`,
          "  await recordConfirmedSend('work', `race-${worker}-${i}`,",
          "    { messageId: `m-${worker}-${i}`, rfc822MessageId: generateRfc822MessageId() });",
          `}`,
          `console.log("DONE " + worker);`,
        ].join("\n"),
      );
      const { spawn } = await import("node:child_process");
      const tsxBin = path.resolve("node_modules", ".bin", "tsx");
      const perWorker = 90;
      const workers = ["a", "b"].map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(tsxBin, [workerScript, w, String(perWorker)], {
              env: { ...process.env, GMAIL_CONFIG_DIR: dir },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let err = "";
            child.stderr?.on("data", (chunk: Buffer) => {
              err += chunk.toString();
            });
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`worker ${w} exited ${code}: ${err}`)),
            );
          }),
      );
      await Promise.all(workers);

      for (const w of ["a", "b"]) {
        for (let i = 0; i < perWorker; i++) {
          const record = await lookupIdempotencyKey("work", `race-${w}-${i}`, env);
          expect(record?.messageId).toBe(`m-${w}-${i}`);
        }
      }
    },
    120_000,
  );

  it("never evicts pending records to enforce the entry cap", async () => {
    // A pending record is an in-flight send: evicting it under the entry
    // cap would let a later retry miss its dedup state and double-send.
    // The cap must shed confirmed records first.
    const env = testEnv();
    const dir = env.GMAIL_CONFIG_DIR;
    if (!dir) throw new Error("test env missing GMAIL_CONFIG_DIR");
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    const store: Record<string, unknown> = {};
    for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES; i++) {
      store[`sent-${i}`] = {
        status: "sent",
        rfc822MessageId: `<sent-${i}@t>`,
        messageId: `m${i}`,
        createdAt: now - i,
      };
    }
    const inflight = scopedIdempotencyKey("work", "inflight");
    store[inflight] = {
      status: "pending",
      rfc822MessageId: "<inflight@t>",
      // Oldest record in the file — first in line for eviction under the
      // old policy.
      createdAt: now - IDEMPOTENCY_MAX_ENTRIES - 1,
    };
    await fs.writeFile(path.join(dir, "idempotency.json"), JSON.stringify(store));

    await recordPendingSend("work", "new", generateRfc822MessageId(), env);

    expect((await lookupIdempotencyKey("work", "inflight", env))?.status).toBe("pending");
    expect(await lookupIdempotencyKey("work", "new", env)).not.toBeUndefined();
    // The cap still holds: one confirmed record was shed instead.
    const raw = JSON.parse(await fs.readFile(path.join(dir, "idempotency.json"), "utf8"));
    expect(Object.keys(raw)).toHaveLength(IDEMPOTENCY_MAX_ENTRIES);
  });
});
