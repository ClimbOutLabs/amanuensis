// Handler-level tests for src/core/ops/messages.ts.
//
// Covers read_email, search_emails, modify_email label precedence,
// delete_email, and schema parsing.
//
// Strategy: import the module so the ops register themselves on the singleton
// registry, then dispatch by name with a hand-rolled OperationContext whose
// `gmail` field is a deep nest of vi.fn() stubs. No real Gmail API calls.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import {
  DeleteEmailSchema,
  ModifyEmailSchema,
  ReadEmailSchema,
  SearchEmailsSchema,
} from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers readEmail / searchEmails / modifyEmail / deleteEmail.
import "./messages.js";

// Build a context whose gmail.users.messages.* are all vi.fn()s with the
// provided per-method overrides. Anything not overridden is a noop fn.
function makeCtx(overrides: {
  get?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  modify?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): OperationContext {
  const messages = {
    get: overrides.get ?? vi.fn(),
    list: overrides.list ?? vi.fn(),
    modify: overrides.modify ?? vi.fn(),
    delete: overrides.delete ?? vi.fn(),
  };
  const gmail = {
    users: { messages },
  } as unknown as gmail_v1.Gmail;
  return {
    gmail,
    oauth2Client: {} as OAuth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
  };
}

describe("read_email handler", () => {
  it("renders full message and populates structuredContent (1.1)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      data: {
        threadId: "T123",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: "hi" },
            { name: "From", value: "a@b.com" },
            { name: "To", value: "c@d.com" },
            { name: "Cc", value: "cc@d.com" },
            { name: "Bcc", value: "bcc@d.com" },
            { name: "Date", value: "2026-05-01" },
            { name: "Message-ID", value: "<msg-1@example>" },
          ],
          body: { data: Buffer.from("hello world", "utf8").toString("base64") },
        },
      },
    });
    const ctx = makeCtx({ get: getMock });

    const result = await registry.dispatch("read_email", { messageId: "M1" }, ctx);

    expect(getMock).toHaveBeenCalledWith({ userId: "me", id: "M1", format: "full" }, { signal: undefined });
    expect(result.content[0].text).toContain("Thread ID: T123");
    expect(result.content[0].text).toContain("Subject: hi");
    expect(result.content[0].text).toContain("hello world");
    expect(result.content[0].text).toContain("CC: cc@d.com");
    expect(result.content[0].text).toContain("BCC: bcc@d.com");
    expect(result.structuredContent).toMatchObject({
      messageId: "M1",
      threadId: "T123",
      subject: "hi",
      from: "a@b.com",
      to: "c@d.com",
      cc: "cc@d.com",
      bcc: "bcc@d.com",
      date: "2026-05-01",
      rfcMessageId: "<msg-1@example>",
      body: "hello world",
      bodyText: "hello world",
      bodyHtml: "",
      attachments: [],
    });
  });

  it("renders readable text for HTML-only messages while preserving raw HTML fields (1.1)", async () => {
    const getMock = vi.fn().mockResolvedValue({
      data: {
        threadId: "T2",
        payload: {
          mimeType: "text/html",
          headers: [{ name: "Subject", value: "html only" }],
          body: {
            data: Buffer.from("<p>hi <strong>there</strong></p>", "utf8").toString("base64"),
          },
        },
      },
    });
    const ctx = makeCtx({ get: getMock });

    const result = await registry.dispatch("read_email", { messageId: "Mhtml" }, ctx);
    expect(result.content[0].text).toContain("hi there");
    expect(result.content[0].text).not.toContain("<strong>");
    expect(result.structuredContent).toMatchObject({
      body: "hi there",
      bodyHtml: "<p>hi <strong>there</strong></p>",
      bodyText: "",
    });
  });
});

describe("search_emails handler", () => {
  it("defaults maxResults to 10 and fetches metadata per hit (1.3)", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: {
        messages: [
          { id: "m1", threadId: "t1" },
          { id: "m2", threadId: "t2" },
        ],
      },
    });
    const getMock = vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        payload: {
          headers: [
            { name: "Subject", value: `subj-${id}` },
            { name: "From", value: `Sender ${id} <From-${id}@X.com>` },
            { name: "To", value: `Me <ME-${id}@X.com>` },
            { name: "Cc", value: `cc-${id}@x.com` },
            { name: "Date", value: `date-${id}` },
          ],
        },
      },
    }));
    const ctx = makeCtx({ list: listMock, get: getMock });

    const result = await registry.dispatch("search_emails", { query: "in:inbox" }, ctx);

    expect(listMock).toHaveBeenCalledWith({ userId: "me", q: "in:inbox", maxResults: 10 }, { signal: undefined });
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith({
      userId: "me",
      id: "m1",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "To", "Cc", "Date"],
    }, { signal: undefined });
    // threadId surfaced (no extra RPC), from kept raw, structured recipients
    // added with lowercased emails.
    expect(result.structuredContent).toEqual({
      resultCount: 2,
      truncated: false,
      total_available: 2,
      results: [
        {
          id: "m1",
          threadId: "t1",
          subject: "subj-m1",
          from: "Sender m1 <From-m1@X.com>",
          fromAddress: { name: "Sender m1", email: "from-m1@x.com" },
          to: [{ name: "Me", email: "me-m1@x.com" }],
          cc: [{ name: "", email: "cc-m1@x.com" }],
          date: "date-m1",
        },
        {
          id: "m2",
          threadId: "t2",
          subject: "subj-m2",
          from: "Sender m2 <From-m2@X.com>",
          fromAddress: { name: "Sender m2", email: "from-m2@x.com" },
          to: [{ name: "Me", email: "me-m2@x.com" }],
          cc: [{ name: "", email: "cc-m2@x.com" }],
          date: "date-m2",
        },
      ],
    });
  });

  it("honours an explicit maxResults and tolerates an empty result list (1.3)", async () => {    const listMock = vi.fn().mockResolvedValue({ data: {} });
    const getMock = vi.fn();
    const ctx = makeCtx({ list: listMock, get: getMock });

    const result = await registry.dispatch(
      "search_emails",
      { query: "label:important", maxResults: 25 },
      ctx,
    );

    expect(listMock).toHaveBeenCalledWith({ userId: "me", q: "label:important", maxResults: 25 }, { signal: undefined });
    expect(getMock).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      resultCount: 0,
      results: [],
      truncated: false,
      total_available: 0,
    });
  });
});

describe("modify_email handler", () => {
  it("addLabelIds wins over the deprecated labelIds field; removeLabelIds passes through (1.4)", async () => {
    const modifyMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ modify: modifyMock });

    const result = await registry.dispatch(
      "modify_email",
      {
        messageId: "M9",
        labelIds: ["LEGACY"],
        addLabelIds: ["NEW"],
        removeLabelIds: ["GONE"],
      },
      ctx,
    );

    expect(modifyMock).toHaveBeenCalledWith({
      userId: "me",
      id: "M9",
      requestBody: { addLabelIds: ["NEW"], removeLabelIds: ["GONE"] },
    }, { signal: undefined });
    expect(result.structuredContent).toEqual({ messageId: "M9", status: "modified" });
  });

  it("falls back to labelIds → addLabelIds when only the deprecated field is supplied (1.4)", async () => {
    const modifyMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ modify: modifyMock });

    await registry.dispatch("modify_email", { messageId: "M10", labelIds: ["L1", "L2"] }, ctx);

    expect(modifyMock).toHaveBeenCalledWith({
      userId: "me",
      id: "M10",
      requestBody: { addLabelIds: ["L1", "L2"] },
    }, { signal: undefined });
  });
});

describe("delete_email handler (1.5)", () => {
  it("calls gmail.users.messages.delete and returns deleted status", async () => {
    const deleteMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ delete: deleteMock });

    const result = await registry.dispatch("delete_email", { messageId: "Mdel" }, ctx);

    expect(deleteMock).toHaveBeenCalledWith({ userId: "me", id: "Mdel" }, { signal: undefined });
    expect(result.content[0].text).toBe("Email Mdel deleted successfully");
    expect(result.structuredContent).toEqual({ messageId: "Mdel", status: "deleted" });
  });
});

describe("report_phishing handler", () => {
  it("applies SPAM and discloses the Gmail API limitation", async () => {
    const modifyMock = vi.fn().mockResolvedValue({ data: {} });
    const result = await registry.dispatch(
      "report_phishing",
      { messageId: "Mphish" },
      makeCtx({ modify: modifyMock }),
    );
    expect(modifyMock).toHaveBeenCalledWith({
      userId: "me",
      id: "Mphish",
      requestBody: { addLabelIds: ["SPAM"] },
    }, { signal: undefined });
    expect(result.content[0].text).toContain("no native phishing-report endpoint");
    expect(result.structuredContent).toMatchObject({
      messageId: "Mphish",
      labelApplied: "SPAM",
      status: "reported_as_spam",
    });
  });
});

describe("schema parse (1.6)", () => {
  it("ReadEmailSchema requires messageId", () => {
    expect(ReadEmailSchema.parse({ messageId: "abc" })).toEqual({ messageId: "abc" });
    expect(() => ReadEmailSchema.parse({})).toThrow();
  });

  it("SearchEmailsSchema requires query and accepts optional maxResults", () => {
    expect(SearchEmailsSchema.parse({ query: "in:inbox" })).toEqual({ query: "in:inbox" });
    expect(SearchEmailsSchema.parse({ query: "x", maxResults: 5 })).toEqual({
      query: "x",
      maxResults: 5,
    });
    expect(() => SearchEmailsSchema.parse({})).toThrow();
  });

  it("ModifyEmailSchema requires messageId; all label arrays are optional", () => {
    expect(ModifyEmailSchema.parse({ messageId: "m" })).toEqual({ messageId: "m" });
    expect(
      ModifyEmailSchema.parse({
        messageId: "m",
        labelIds: ["A"],
        addLabelIds: ["B"],
        removeLabelIds: ["C"],
      }),
    ).toEqual({
      messageId: "m",
      labelIds: ["A"],
      addLabelIds: ["B"],
      removeLabelIds: ["C"],
    });
    expect(() => ModifyEmailSchema.parse({ labelIds: ["A"] })).toThrow();
  });

  it("DeleteEmailSchema requires messageId", () => {
    expect(DeleteEmailSchema.parse({ messageId: "m" })).toEqual({ messageId: "m" });
    expect(() => DeleteEmailSchema.parse({})).toThrow();
  });
});
