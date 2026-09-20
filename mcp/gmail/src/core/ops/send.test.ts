// Handler-level tests for reply_all's closest-identity reply-from selection.
//
// Mocks the gmail surfaces reply_all + handleEmailAction touch: messages.get
// (original), getProfile, settings.sendAs.list, threads.get (threading), and
// messages.send. Asserts which send-as identity is chosen and that it reaches
// the sent message's From header.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers send_email + reply_all.
import "./send.js";

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function makeReplyCtx(opts: {
  to: string;
  sendAs: Array<{ sendAsEmail: string; isDefault?: boolean }>;
  send: ReturnType<typeof vi.fn>;
}): OperationContext {
  const messagesGet = vi.fn().mockResolvedValue({
    data: {
      threadId: "T1",
      payload: {
        headers: [
          { name: "From", value: "External Sender <ext@somewhere.example>" },
          { name: "To", value: opts.to },
          { name: "Subject", value: "Question" },
          { name: "Message-ID", value: "<orig@somewhere.example>" },
        ],
      },
    },
  });
  const threadsGet = vi.fn().mockResolvedValue({
    data: { messages: [{ payload: { headers: [{ name: "Message-ID", value: "<orig@x>" }] } }] },
  });
  const getProfile = vi
    .fn()
    .mockResolvedValue({ data: { emailAddress: "user-work@fixture.test" } });
  const sendAsList = vi.fn().mockResolvedValue({ data: { sendAs: opts.sendAs } });

  const gmail = {
    users: {
      messages: { get: messagesGet, send: opts.send },
      threads: { get: threadsGet },
      getProfile,
      settings: { sendAs: { list: sendAsList } },
    },
  } as unknown as gmail_v1.Gmail;

  return {
    gmail,
    oauth2Client: {} as OAuth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
  };
}

describe("reply_all reply-from selection", () => {
  it("replies from the same-domain alias for a catch-all recipient", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "sent1", threadId: "T1" } });
    const ctx = makeReplyCtx({
      to: "random@catchall.fixture.test",
      sendAs: [
        { sendAsEmail: "user-work@fixture.test", isDefault: true },
        { sendAsEmail: "admin@catchall.fixture.test" },
      ],
      send,
    });

    const result = await registry.dispatch("reply_all", { messageId: "M1", body: "hi" }, ctx);

    expect((result.structuredContent as { fromIdentity: string }).fromIdentity).toBe(
      "admin@catchall.fixture.test",
    );
    // The chosen identity actually reaches the sent message's From header.
    const raw = send.mock.calls[0][0].requestBody.raw as string;
    expect(decodeRaw(raw)).toContain("From: admin@catchall.fixture.test");
  });

  it("honours an explicit from override without consulting send-as settings", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "sent2", threadId: "T1" } });
    const sendAsList = vi.fn();
    const ctx = makeReplyCtx({
      to: "random@catchall.fixture.test",
      sendAs: [{ sendAsEmail: "admin@catchall.fixture.test" }],
      send,
    });
    // Swap in a spy that must NOT be called when `from` is explicit.
    (ctx.gmail as any).users.settings.sendAs.list = sendAsList;

    const result = await registry.dispatch(
      "reply_all",
      { messageId: "M1", body: "hi", from: "sales@catchall.fixture.test" },
      ctx,
    );

    expect(sendAsList).not.toHaveBeenCalled();
    expect((result.structuredContent as { fromIdentity: string }).fromIdentity).toBe(
      "sales@catchall.fixture.test",
    );
  });

  it("falls back to the account default (null) when no alias is closer", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "sent3", threadId: "T1" } });
    const ctx = makeReplyCtx({
      to: "someone@unrelated.example",
      sendAs: [
        { sendAsEmail: "user-work@fixture.test", isDefault: true },
        { sendAsEmail: "admin@catchall.fixture.test" },
      ],
      send,
    });

    const result = await registry.dispatch("reply_all", { messageId: "M1", body: "hi" }, ctx);

    expect((result.structuredContent as { fromIdentity: string | null }).fromIdentity).toBeNull();
    const raw = send.mock.calls[0][0].requestBody.raw as string;
    // No override → default send-as ("me"), so no explicit alias in From.
    expect(decodeRaw(raw)).toContain("From: me");
  });

  it("degrades gracefully when send-as settings are unreadable", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "sent4", threadId: "T1" } });
    const ctx = makeReplyCtx({
      to: "random@catchall.fixture.test",
      sendAs: [],
      send,
    });
    (ctx.gmail as any).users.settings.sendAs.list = vi
      .fn()
      .mockRejectedValue(new Error("insufficient scope"));

    const result = await registry.dispatch("reply_all", { messageId: "M1", body: "hi" }, ctx);
    // Settings read failed → reply still sent, from-identity left as default.
    expect((result.structuredContent as { fromIdentity: string | null }).fromIdentity).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
