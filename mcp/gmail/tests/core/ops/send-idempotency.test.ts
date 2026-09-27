// Handler-level tests for send idempotency (H2).
//
// Covers: first send records the key (pending intent → confirmed); a retry
// with the same key returns the recorded result without re-sending
// (idempotent_replay: true); a stale record (recorded message 404s) is
// forgotten and the send proceeds; a crash between send and confirmation is
// recovered via the pending record + Message-ID search; records are scoped
// per account; sends without a key and draft creation never touch the store.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../../../src/core/context.js";
import {
  generateRfc822MessageId,
  recordPendingSend,
} from "../../../src/core/idempotency.js";
import { registry } from "../../../src/core/registry.js";
import { _resetForTests, setSession } from "../../../src/core/session.js";
import "../../../src/core/ops/send.js"; // side-effect: registers send_email / reply_all

const configDirs: string[] = [];
const savedConfigDir = process.env.GMAIL_CONFIG_DIR;
const savedReconcileDelay = process.env.GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS;

function useTempConfigDir(): string {
  const dir = path.join(
    tmpdir(),
    `gmail-send-idem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  configDirs.push(dir);
  process.env.GMAIL_CONFIG_DIR = dir;
  return dir;
}

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.GMAIL_CONFIG_DIR;
  else process.env.GMAIL_CONFIG_DIR = savedConfigDir;
  if (savedReconcileDelay === undefined) delete process.env.GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS;
  else process.env.GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS = savedReconcileDelay;
  while (configDirs.length > 0) {
    const dir = configDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  _resetForTests();
});

function makeFakeGmail(
  overrides: {
    send?: ReturnType<typeof vi.fn>;
    get?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    users: {
      messages: {
        send: overrides.send ?? vi.fn(async () => ({ data: { id: "msg-new" } })),
        get: overrides.get ?? vi.fn(async () => ({ data: { id: "msg-new" } })),
        list: overrides.list ?? vi.fn(async () => ({ data: { messages: [] } })),
      },
    },
  };
}

function makeCtx(gmail: unknown, signal?: AbortSignal, accountId: string | null = "acct-a"): OperationContext {
  const ctx: OperationContext = {
    gmail: gmail as OperationContext["gmail"],
    oauth2Client: {} as OperationContext["oauth2Client"],
    authorizedScopes: ["gmail.send"],
    toolName: "send_email",
    // Pinned at request start, like createContext does.
    accountId,
  };
  if (signal) ctx.signal = signal;
  return ctx;
}

function setAccount(accountId: string | null): void {
  setSession({
    oauth2Client: {} as OperationContext["oauth2Client"],
    gmail: {} as OperationContext["gmail"],
    authorizedScopes: ["gmail.send"],
    accountId,
  });
}

const baseArgs = {
  to: ["a@example.com"],
  subject: "hello",
  body: "world",
};

describe("send_email idempotency", () => {
  it("records the key on first send and replays without re-sending", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-1" } }));
    const get = vi.fn(async () => ({ data: { id: "msg-1" } }));
    const gmail = makeFakeGmail({ send, get });

    const first = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-abc" },
      makeCtx(gmail),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.structuredContent).toMatchObject({ messageId: "msg-1", action: "sent" });

    const retry = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-abc" },
      makeCtx(gmail),
    );
    // No second send — the replay path verified via messages.get instead.
    expect(send).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(retry.structuredContent).toMatchObject({
      messageId: "msg-1",
      action: "sent",
      idempotent_replay: true,
    });
    expect(retry.content[0]?.text).toContain("idempotent replay");
  });

  it("threads the abort signal through the reconciliation lookup", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-sig" } }));
    const get = vi.fn(async () => ({ data: { id: "msg-sig" } }));
    const gmail = makeFakeGmail({ send, get });
    const controller = new AbortController();

    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-sig" },
      makeCtx(gmail, controller.signal),
    );
    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-sig" },
      makeCtx(gmail, controller.signal),
    );
    expect(get).toHaveBeenCalledWith(
      { userId: "me", id: "msg-sig", format: "minimal" },
      { signal: controller.signal },
    );
  });

  it("scopes records per account: the same key on another account sends again", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-acct" } }));
    const gmail = makeFakeGmail({ send });

    // The account is pinned per request (ctx.accountId), mirroring
    // createContext(); setAccount models the global session for realism.
    setAccount("work");
    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "shared-key" },
      makeCtx(gmail, undefined, "work"),
    );
    expect(send).toHaveBeenCalledTimes(1);

    // Same key, different account → no replay, sends again.
    setAccount("personal");
    const retry = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "shared-key" },
      makeCtx(gmail, undefined, "personal"),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(retry.structuredContent).not.toMatchObject({ idempotent_replay: true });

    // Back on work → replays the work record without sending.
    setAccount("work");
    const replay = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "shared-key" },
      makeCtx(gmail, undefined, "work"),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(replay.structuredContent).toMatchObject({ idempotent_replay: true });
  });

  it("pins idempotency scope to the request account even if the global session switches mid-request", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-pin" } }));
    const get = vi.fn(async () => ({ data: { id: "msg-pin" } }));
    const gmail = makeFakeGmail({ send, get });

    // Request starts on "work"; the global session switches to "personal"
    // before the send completes (concurrent switch_account). The dedup
    // record must stay scoped to "work" — the account the request's gmail
    // client was bound to — not the session's account at send time.
    setAccount("work");
    const ctx = makeCtx(gmail, undefined, "work");
    const first = registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "pin-key" },
      ctx,
    );
    setAccount("personal");
    await first;
    expect(send).toHaveBeenCalledTimes(1);

    // A retry for "work" replays; a retry for "personal" would send again
    // (different scope) — proving the record was NOT descoped by the switch.
    const replay = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "pin-key" },
      makeCtx(gmail, undefined, "work"),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(replay.structuredContent).toMatchObject({ idempotent_replay: true });
  });

  it("recovers a crash between send and confirmation via the Message-ID search", async () => {
    useTempConfigDir();
    const rfc822MessageId = generateRfc822MessageId();
    // Simulate: intent recorded, messages.send succeeded, process died
    // before the confirmation write.
    await recordPendingSend("default", "key-crash", rfc822MessageId);

    const send = vi.fn(async () => ({ data: { id: "msg-should-not-send" } }));
    const list = vi.fn(async () => ({
      data: { messages: [{ id: "msg-landed", threadId: "thr-landed" }] },
    }));
    const gmail = makeFakeGmail({ send, list });

    const retry = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-crash" },
      makeCtx(gmail, undefined, "default"),
    );
    // The send did land (found by Message-ID) → replay, no new send.
    expect(send).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(
      { userId: "me", q: `rfc822msgid:${rfc822MessageId.slice(1, -1)}`, maxResults: 1 },
      { signal: undefined },
    );
    expect(retry.structuredContent).toMatchObject({
      messageId: "msg-landed",
      action: "sent",
      idempotent_replay: true,
    });

    // A further retry now hits the promoted confirmed record.
    const get = vi.fn(async () => ({ data: { id: "msg-landed" } }));
    const gmail2 = makeFakeGmail({ send, get, list });
    const retry2 = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-crash" },
      makeCtx(gmail2, undefined, "default"),
    );
    expect(send).not.toHaveBeenCalled();
    expect(retry2.structuredContent).toMatchObject({
      messageId: "msg-landed",
      idempotent_replay: true,
    });
  });

  it("fails closed when a pending record's Message-ID is not found after the bounded search", async () => {
    useTempConfigDir();
    // Keep the bounded re-search loop fast: the loop itself (3 attempts) is
    // what this test exercises, not the 10s production delay.
    process.env.GMAIL_IDEMPOTENCY_RECONCILE_DELAY_MS = "0";
    const rfc822MessageId = generateRfc822MessageId();
    await recordPendingSend("default", "key-noland", rfc822MessageId);

    const send = vi.fn(async () => ({ data: { id: "msg-fresh" } }));
    const list = vi.fn(async () => ({ data: { messages: [] } }));
    const gmail = makeFakeGmail({ send, list });

    // At-most-once: the bounded search missed, so we do NOT resend — the
    // gate throws, which the server layer converts to an isError envelope.
    await expect(
      registry.dispatch(
        "send_email",
        { ...baseArgs, idempotencyKey: "key-noland" },
        makeCtx(gmail, undefined, "default"),
      ),
    ).rejects.toThrow(/could not be confirmed.*NOT resending/s);
    expect(send).not.toHaveBeenCalled();
    // Bounded re-search: all attempts miss before failing closed.
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("reply_all replays with the same idempotency key without re-sending", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "reply-1", threadId: "T1" } }));
    const messagesGet = vi.fn(async () => ({
      data: {
        threadId: "T1",
        payload: {
          headers: [
            { name: "From", value: "External Sender <ext@somewhere.example>" },
            { name: "To", value: "me@fixture.test" },
            { name: "Subject", value: "Question" },
            { name: "Message-ID", value: "<orig@somewhere.example>" },
          ],
        },
      },
    }));
    const getProfile = vi.fn(async () => ({ data: { emailAddress: "me@fixture.test" } }));
    const sendAsList = vi.fn(async () => ({ data: { sendAs: [] } }));
    const threadsGet = vi.fn(async () => ({ data: { messages: [] } }));
    const list = vi.fn(async () => ({ data: { messages: [] } }));
    const gmail = {
      users: {
        messages: { get: messagesGet, send, list },
        threads: { get: threadsGet },
        getProfile,
        settings: { sendAs: { list: sendAsList } },
      },
    };

    const args = { messageId: "M1", body: "reply body", idempotencyKey: "reply-key" };
    const first = await registry.dispatch("reply_all", args, makeCtx(gmail, undefined, "default"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.structuredContent).not.toMatchObject({ idempotent_replay: true });

    // Same key → the confirmed record replays; the original is fetched again
    // (reply construction) but no second send goes out.
    const second = await registry.dispatch("reply_all", args, makeCtx(gmail, undefined, "default"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(second.structuredContent).toMatchObject({ idempotent_replay: true });
  });

  it("fails closed when the reconcile wait is aborted", async () => {
    useTempConfigDir();
    const rfc822MessageId = generateRfc822MessageId();
    await recordPendingSend("default", "key-abort", rfc822MessageId);

    const send = vi.fn(async () => ({ data: { id: "msg-abort" } }));
    const list = vi.fn(async () => ({ data: { messages: [] } }));
    const gmail = makeFakeGmail({ send, list });

    // Already-aborted signal: the gate must not send and must not swallow
    // the cancellation.
    const controller = new AbortController();
    controller.abort(new Error("client went away"));
    await expect(
      registry.dispatch(
        "send_email",
        { ...baseArgs, idempotencyKey: "key-abort" },
        makeCtx(gmail, controller.signal, "default"),
      ),
    ).rejects.toThrow(/cancelled while waiting/);
    expect(send).not.toHaveBeenCalled();
    // First search ran, then the aborted wait stopped the loop.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("injects the generated Message-ID into the outgoing message", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-mid" } }));
    const gmail = makeFakeGmail({ send });
    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-mid" },
      makeCtx(gmail),
    );
    const sentRaw: { raw: string } = send.mock.calls[0]?.[0]?.requestBody;
    const decoded = Buffer.from(
      sentRaw.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toMatch(/^Message-ID: <[^>]+@gmail-mcp>$/m);
  });

  it("injects the idempotency Message-ID on the nodemailer attachment path", async () => {
    const dir = useTempConfigDir();
    const attachmentsDir = path.join(dir, "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "note.txt"), "attachment body");

    const send = vi.fn(async () => ({ data: { id: "msg-att" } }));
    const gmail = makeFakeGmail({ send });
    await registry.dispatch(
      "send_email",
      { ...baseArgs, attachments: ["note.txt"], idempotencyKey: "key-att" },
      makeCtx(gmail),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const sentRaw: { raw: string } = send.mock.calls[0]?.[0]?.requestBody;
    const decoded = Buffer.from(
      sentRaw.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    // The crash-recovery search keys on this header — it must be present on
    // the MIME path too, not just the simple text path.
    expect(decoded).toMatch(/^Message-ID: <[^>]+@gmail-mcp>$/m);
    expect(decoded).toContain("note.txt");
  });

  it("re-sends when the recorded message no longer exists (stale record)", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-2" } }));
    const notFound = Object.assign(new Error("not found"), { code: 404 });
    const get = vi.fn(async () => {
      throw notFound;
    });
    const gmail = makeFakeGmail({ send, get });

    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-stale" },
      makeCtx(gmail),
    );
    expect(send).toHaveBeenCalledTimes(1);

    // Retry: record exists but the message 404s → record forgotten, send proceeds.
    const send2 = vi.fn(async () => ({ data: { id: "msg-3" } }));
    const gmail2 = makeFakeGmail({ send: send2, get });
    const retry = await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-stale" },
      makeCtx(gmail2),
    );
    expect(send2).toHaveBeenCalledTimes(1);
    expect(retry.structuredContent).toMatchObject({ messageId: "msg-3", action: "sent" });
    expect(retry.structuredContent).not.toMatchObject({ idempotent_replay: true });
  });

  it("fails closed when the verification lookup errors transiently", async () => {
    useTempConfigDir();
    const send = vi.fn(async () => ({ data: { id: "msg-4" } }));
    const gmail = makeFakeGmail({ send });
    await registry.dispatch(
      "send_email",
      { ...baseArgs, idempotencyKey: "key-flaky" },
      makeCtx(gmail),
    );

    const boom = new Error("socket hangup");
    const gmail2 = makeFakeGmail({
      get: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(
      registry.dispatch(
        "send_email",
        { ...baseArgs, idempotencyKey: "key-flaky" },
        makeCtx(gmail2),
      ),
    ).rejects.toThrow("Idempotency check failed");
  });

  it("serializes concurrent sends with the same key (no double-send)", async () => {
    useTempConfigDir();
    let sendCount = 0;
    const send = vi.fn(async () => {
      sendCount += 1;
      // Small delay widens the race window — without the per-key lock both
      // callers would pass the lookup before either records.
      await new Promise((r) => setTimeout(r, 20));
      return { data: { id: `msg-race-${sendCount}` } };
    });
    const get = vi.fn(async () => ({ data: { id: "msg-race-1" } }));
    const gmail = makeFakeGmail({ send, get });
    const ctx = makeCtx(gmail);
    const args = { ...baseArgs, idempotencyKey: "key-race" };

    const [r1, r2] = await Promise.all([
      registry.dispatch("send_email", args, ctx),
      registry.dispatch("send_email", args, ctx),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const replays = [r1, r2].filter(
      (r) => r.content[0]?.text.includes("idempotent replay") ?? false,
    );
    expect(replays).toHaveLength(1);
    expect(r1.structuredContent).toMatchObject({ messageId: "msg-race-1" });
    expect(r2.structuredContent).toMatchObject({ messageId: "msg-race-1" });
  });

  it("does not touch the store when no key is supplied", async () => {
    const dir = useTempConfigDir();
    const gmail = makeFakeGmail();
    await registry.dispatch("send_email", baseArgs, makeCtx(gmail));
    await expect(
      fs.access(path.join(dir, "idempotency.json")).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it("ignores the key for draft creation", async () => {
    const dir = useTempConfigDir();
    const create = vi.fn(async () => ({ data: { id: "draft-1" } }));
    const gmail = {
      users: { messages: {}, drafts: { create } },
    };
    await import("../../../src/core/ops/drafts.js"); // side-effect: registers draft_email
    const result = await registry.dispatch(
      "draft_email",
      { ...baseArgs, idempotencyKey: "key-draft" },
      makeCtx(gmail),
    );
    expect(result.structuredContent).toMatchObject({ action: "drafted" });
    await expect(
      fs.access(path.join(dir, "idempotency.json")).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });
});
