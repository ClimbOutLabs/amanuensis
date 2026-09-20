// Handler-level tests for src/core/ops/threads.ts.
// Mocks ctx.gmail.users.threads.{get,list,modify} and dispatches via the
// process registry.

import { describe, expect, it, vi } from "vitest";
import { GetThreadSchema } from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers get_thread, list_inbox_threads,
// get_inbox_with_threads, modify_thread on the singleton registry.
import "./threads.js";

/**
 * Build a minimal OperationContext with a stub gmail.users.threads surface.
 * Only the methods each test exercises are wired; missing methods will
 * deliberately throw if a handler reaches for them.
 */
function buildCtx(
  threadsStub: {
    get?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
    modify?: ReturnType<typeof vi.fn>;
  },
  messagesGet?: ReturnType<typeof vi.fn>,
): OperationContext {
  return {
    gmail: {
      users: {
        threads: {
          get: threadsStub.get ?? vi.fn(),
          list: threadsStub.list ?? vi.fn(),
          modify: threadsStub.modify ?? vi.fn(),
        },
        messages: {
          get: messagesGet ?? vi.fn(),
        },
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for tests
    oauth2Client: {} as any,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for tests
  } as any;
}

describe("GetThreadSchema", () => {
  it("requires exactly one of threadId / messageId", () => {
    expect(GetThreadSchema.parse({ threadId: "t" })).toMatchObject({ threadId: "t" });
    expect(GetThreadSchema.parse({ messageId: "m" })).toMatchObject({ messageId: "m" });
    expect(() => GetThreadSchema.parse({})).toThrow(/exactly one/);
    expect(() => GetThreadSchema.parse({ threadId: "t", messageId: "m" })).toThrow(/exactly one/);
  });
});

describe("get_thread handler", () => {
  it("returns per-message summary with headers + body and skips body when format=minimal", async () => {
    // Two messages: first full (with body), second tested separately under minimal format below.
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "msg-1",
            threadId: "thread-A",
            labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "Subject", value: "Hello" },
                { name: "From", value: "a@example.com" },
                { name: "To", value: "b@example.com" },
                { name: "Cc", value: "c@example.com" },
                { name: "Date", value: "2026-01-01" },
              ],
              mimeType: "text/plain",
              body: {
                data: Buffer.from("body text").toString("base64url"),
                size: 9,
              },
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ get });

    const op = registry.get("get_thread")!;
    const result = await op.handler({ threadId: "thread-A" }, ctx);

    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "thread-A",
      format: "full", // handler default when args.format is undefined
    }, { signal: undefined });
    expect(result.structuredContent).toMatchObject({
      threadId: "thread-A",
      messageCount: 1,
    });
    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const msg = (result.structuredContent as any).messages[0];
    expect(msg.messageId).toBe("msg-1");
    expect(msg.subject).toBe("Hello");
    expect(msg.from).toBe("a@example.com");
    expect(msg.cc).toBe("c@example.com");
    expect(msg.body).toBe("body text");
    expect(msg.labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("accepts a messageId: resolves its threadId (minimal fetch) then loads the thread", async () => {
    const messagesGet = vi.fn().mockResolvedValue({ data: { threadId: "thread-R" } });
    const threadsGet = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "msg-9",
            threadId: "thread-R",
            payload: { headers: [{ name: "Subject", value: "Resolved" }], mimeType: "text/plain" },
          },
        ],
      },
    });
    const ctx = buildCtx({ get: threadsGet }, messagesGet);

    const op = registry.get("get_thread")!;
    const result = await op.handler({ messageId: "msg-9", format: "full" }, ctx);

    // Cheap minimal fetch just to get the threadId, then the real thread load.
    expect(messagesGet).toHaveBeenCalledWith({ userId: "me", id: "msg-9", format: "minimal" }, { signal: undefined });
    expect(threadsGet).toHaveBeenCalledWith({ userId: "me", id: "thread-R", format: "full" }, { signal: undefined });
    expect(result.structuredContent).toMatchObject({ threadId: "thread-R", messageCount: 1 });
  });

  it("throws when a messageId resolves to no threadId", async () => {
    const messagesGet = vi.fn().mockResolvedValue({ data: {} });
    const ctx = buildCtx({ get: vi.fn() }, messagesGet);
    const op = registry.get("get_thread")!;
    await expect(op.handler({ messageId: "orphan" }, ctx)).rejects.toThrow(/resolve a threadId/);
  });

  it("skips body extraction when format=minimal", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "msg-2",
            threadId: "thread-B",
            payload: {
              headers: [{ name: "Subject", value: "Skip body" }],
              mimeType: "text/plain",
              body: {
                data: Buffer.from("should-not-appear").toString("base64url"),
                size: 17,
              },
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ get });

    const op = registry.get("get_thread")!;
    const result = await op.handler({ threadId: "thread-B", format: "minimal" }, ctx);

    expect(get).toHaveBeenCalledWith({ userId: "me", id: "thread-B", format: "minimal" }, { signal: undefined });
    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const msg = (result.structuredContent as any).messages[0];
    expect(msg.body).toBe("");
    expect(msg.subject).toBe("Skip body");
  });

  it("renders a readable transcript and derives plain text from HTML-only messages", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "msg-html",
            threadId: "thread-html",
            labelIds: ["INBOX", "SENT"],
            payload: {
              headers: [
                { name: "Subject", value: "HTML report" },
                { name: "From", value: "me@example.com" },
                { name: "To", value: "team@example.com" },
                { name: "Cc", value: "lead@example.com" },
                { name: "Date", value: "2026-05-29" },
              ],
              mimeType: "multipart/mixed",
              parts: [
                {
                  mimeType: "text/html",
                  body: {
                    data: Buffer.from(
                      "<p>Build <strong>passed</strong>.</p><p>Ship it.</p>",
                    ).toString("base64url"),
                    size: 48,
                  },
                },
                {
                  filename: "report.txt",
                  mimeType: "text/plain",
                  body: { attachmentId: "att-report", size: 123 },
                },
              ],
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ get });

    const op = registry.get("get_thread")!;
    const result = await op.handler({ threadId: "thread-html" }, ctx);

    const text = result.content[0].text;
    expect(text).toContain("Thread thread-html (1 message)");
    expect(text).toContain("From: me@example.com");
    expect(text).toContain("To: team@example.com");
    expect(text).toContain("Cc: lead@example.com");
    expect(text).toContain("Labels: INBOX, SENT");
    expect(text).toContain("Attachments: report.txt (text/plain, 0 KB)");
    expect(text).toContain("Build passed.\n\nShip it.");
    expect(text).not.toContain("<strong>");
    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const msg = (result.structuredContent as any).messages[0];
    expect(msg.body).toBe("Build passed.\n\nShip it.");
  });
});

describe("list_inbox_threads handler", () => {
  it("uses default query 'in:inbox' and maxResults=50 when args omitted", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { threads: [{ id: "t1", snippet: "snippet-1", historyId: "h1" }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: "From", value: "x@example.com" },
                { name: "Subject", value: "Subj" },
                { name: "Date", value: "2026-02-02" },
              ],
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ list, get });

    const op = registry.get("list_inbox_threads")!;
    const result = await op.handler({}, ctx);

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: "in:inbox",
      maxResults: 50,
    }, { signal: undefined });
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "t1",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    }, { signal: undefined });
    expect(result.structuredContent).toMatchObject({
      resultCount: 1,
      threads: [
        {
          threadId: "t1",
          snippet: "snippet-1",
          historyId: "h1",
          messageCount: 1,
          latestMessage: {
            from: "x@example.com",
            subject: "Subj",
            date: "2026-02-02",
          },
        },
      ],
    });
  });
});

describe("get_inbox_with_threads handler", () => {
  it("returns summary shape when expandThreads=false (no full-format get calls)", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { threads: [{ id: "t-sum", snippet: "snip", historyId: "h" }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: "From", value: "summary@example.com" },
                { name: "Subject", value: "S" },
                { name: "Date", value: "2026-03-03" },
              ],
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ list, get });

    const op = registry.get("get_inbox_with_threads")!;
    const result = await op.handler({ expandThreads: false }, ctx);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "t-sum",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    }, { signal: undefined });
    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const sc = result.structuredContent as any;
    expect(sc.resultCount).toBe(1);
    expect(sc.threads[0].latestMessage.from).toBe("summary@example.com");
    // Summary shape has snippet/messageCount, not full `messages[]`.
    expect(sc.threads[0].snippet).toBe("snip");
    expect(sc.threads[0].messages).toBeUndefined();
  });

  it("returns expanded shape with bodies + attachments when expandThreads=true", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { threads: [{ id: "t-full", snippet: "snip", historyId: "h" }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "m-1",
            threadId: "t-full",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Expanded" },
                { name: "From", value: "exp@example.com" },
                { name: "To", value: "you@example.com" },
                { name: "Date", value: "2026-04-04" },
              ],
              mimeType: "multipart/mixed",
              parts: [
                {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from("expanded body").toString("base64url"),
                    size: 13,
                  },
                },
                {
                  filename: "report.pdf",
                  mimeType: "application/pdf",
                  body: { attachmentId: "att-1", size: 4242 },
                },
              ],
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ list, get });

    const op = registry.get("get_inbox_with_threads")!;
    const result = await op.handler({ expandThreads: true }, ctx);

    expect(get).toHaveBeenCalledWith({ userId: "me", id: "t-full", format: "full" }, { signal: undefined });
    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const sc = result.structuredContent as any;
    expect(sc.resultCount).toBe(1);
    const thread = sc.threads[0];
    expect(thread.threadId).toBe("t-full");
    expect(thread.messageCount).toBe(1);
    expect(thread.messages[0].body).toBe("expanded body");
    // `id` is now included so callers can download attachments without
    // re-fetching via read_email.
    expect(thread.messages[0].attachments).toEqual([
      { id: "att-1", filename: "report.pdf", mimeType: "application/pdf", size: 4242 },
    ]);
  });
});

describe("modify_thread handler", () => {
  it("composes requestBody with only the supplied label fields", async () => {
    const modify = vi.fn().mockResolvedValue({ data: {} });
    const ctx = buildCtx({ modify });

    const op = registry.get("modify_thread")!;
    const result = await op.handler({ threadId: "thread-X", addLabelIds: ["Label_1"] }, ctx);

    expect(modify).toHaveBeenCalledTimes(1);
    const call = modify.mock.calls[0][0];
    expect(call.userId).toBe("me");
    expect(call.id).toBe("thread-X");
    // Crucial: removeLabelIds must be absent (not undefined-passed), since
    // the handler only assigns supplied fields.
    expect(call.requestBody).toEqual({ addLabelIds: ["Label_1"] });
    expect("removeLabelIds" in call.requestBody).toBe(false);
    expect(result.structuredContent).toEqual({ threadId: "thread-X", status: "modified" });
  });

  it("includes both add and remove when both supplied; empty body when neither", async () => {
    const modify = vi.fn().mockResolvedValue({ data: {} });
    const ctx = buildCtx({ modify });
    const op = registry.get("modify_thread")!;

    await op.handler({ threadId: "tid", addLabelIds: ["A"], removeLabelIds: ["B"] }, ctx);
    expect(modify.mock.calls[0][0].requestBody).toEqual({
      addLabelIds: ["A"],
      removeLabelIds: ["B"],
    });

    await op.handler({ threadId: "tid-empty" }, ctx);
    // No fields supplied => empty requestBody (handler asserts the
    // "neither" branch doesn't smuggle in undefineds).
    expect(modify.mock.calls[1][0].requestBody).toEqual({});
  });
});

describe("collectAttachmentMeta (exercised via get_thread)", () => {
  it("walks nested parts and emits flattened metadata with default fallbacks", async () => {
    // Nested structure: payload -> parts[0] (no attachment) -> parts[0].parts[0]
    // (attachment, missing filename + mimeType + size => defaults).
    const get = vi.fn().mockResolvedValue({
      data: {
        messages: [
          {
            id: "m-nested",
            threadId: "t-nested",
            payload: {
              headers: [],
              mimeType: "multipart/mixed",
              parts: [
                {
                  mimeType: "multipart/alternative",
                  parts: [
                    {
                      // Missing filename -> falls back to `attachment-${attachmentId}`.
                      mimeType: "",
                      body: { attachmentId: "att-deep", size: 0 },
                    },
                  ],
                },
                {
                  // Top-level attachment alongside nested -> both must appear.
                  filename: "top.bin",
                  mimeType: "application/octet-stream",
                  body: { attachmentId: "att-top", size: 7 },
                },
              ],
            },
          },
        ],
      },
    });
    const ctx = buildCtx({ get });

    const op = registry.get("get_thread")!;
    const result = await op.handler({ threadId: "t-nested" }, ctx);

    // biome-ignore lint/suspicious/noExplicitAny: structured access
    const msg = (result.structuredContent as any).messages[0];
    expect(msg.attachments).toHaveLength(2);
    // Walk order is depth-first: nested first, then sibling top-level.
    expect(msg.attachments[0]).toEqual({
      id: "att-deep",
      filename: "attachment-att-deep",
      mimeType: "application/octet-stream", // default fallback for empty mimeType
      size: 0,
    });
    expect(msg.attachments[1]).toEqual({
      id: expect.any(String),
      filename: "top.bin",
      mimeType: "application/octet-stream",
      size: 7,
    });
  });
});
