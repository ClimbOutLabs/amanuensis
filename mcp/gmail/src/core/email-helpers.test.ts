import { describe, expect, it } from "vitest";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
  htmlToText,
  listMeta,
} from "./email-helpers.js";

describe("listMeta", () => {
  it("marks a fully-enumerated list as not truncated", () => {
    expect(listMeta(3)).toEqual({ truncated: false, total_available: 3 });
    expect(listMeta(0)).toEqual({ truncated: false, total_available: 0 });
  });

  it("truncates when a nextPageToken exists", () => {
    expect(listMeta(10, { estimate: 42, nextPageToken: "tok" })).toEqual({
      truncated: true,
      total_available: 42,
    });
  });

  it("truncates when the estimate exceeds the returned count even without a token", () => {
    expect(listMeta(10, { estimate: 25 })).toEqual({ truncated: true, total_available: 25 });
  });

  it("never reports total_available below the returned count", () => {
    // A stale/low estimate must not undercount what we actually returned.
    expect(listMeta(10, { estimate: 4 })).toEqual({ truncated: false, total_available: 10 });
  });

  it("falls back to the count when no estimate is given", () => {
    expect(listMeta(7, { nextPageToken: null })).toEqual({ truncated: false, total_available: 7 });
  });
});

describe("extractHeaders", () => {
  it("returns empty strings for missing payload", () => {
    expect(extractHeaders(undefined)).toEqual({
      subject: "",
      from: "",
      to: "",
      cc: "",
      bcc: "",
      date: "",
      rfcMessageId: "",
    });
    expect(extractHeaders(null)).toEqual({
      subject: "",
      from: "",
      to: "",
      cc: "",
      bcc: "",
      date: "",
      rfcMessageId: "",
    });
  });

  it("extracts case-insensitively", () => {
    const headers = [
      { name: "SuBjEcT", value: "hi" },
      { name: "FROM", value: "a@b" },
      { name: "To", value: "c@d" },
      { name: "Date", value: "2026-01-01" },
      { name: "Message-ID", value: "<msg@example>" },
    ];
    expect(extractHeaders({ headers })).toEqual({
      subject: "hi",
      from: "a@b",
      to: "c@d",
      cc: "",
      bcc: "",
      date: "2026-01-01",
      rfcMessageId: "<msg@example>",
    });
  });

  it("returns empty string for headers missing from the payload", () => {
    expect(extractHeaders({ headers: [{ name: "Subject", value: "only-subject" }] })).toEqual({
      subject: "only-subject",
      from: "",
      to: "",
      cc: "",
      bcc: "",
      date: "",
      rfcMessageId: "",
    });
  });
});

describe("extractEmailContent", () => {
  it("decodes base64 text/plain body", () => {
    const result = extractEmailContent({
      mimeType: "text/plain",
      body: { data: Buffer.from("hello world", "utf8").toString("base64") },
    });
    expect(result.text).toBe("hello world");
    expect(result.html).toBe("");
  });

  it("decodes base64 text/html body", () => {
    const result = extractEmailContent({
      mimeType: "text/html",
      body: { data: Buffer.from("<p>hi</p>", "utf8").toString("base64") },
    });
    expect(result.text).toBe("");
    expect(result.html).toBe("<p>hi</p>");
  });

  it("recurses into multipart parts and concatenates", () => {
    const result = extractEmailContent({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("plain", "utf8").toString("base64") } },
        {
          mimeType: "text/html",
          body: { data: Buffer.from("<b>html</b>", "utf8").toString("base64") },
        },
      ],
    });
    expect(result.text).toBe("plain");
    expect(result.html).toBe("<b>html</b>");
  });

  it("handles missing body data", () => {
    expect(extractEmailContent({})).toEqual({ text: "", html: "" });
  });
});

describe("htmlToText", () => {
  it("converts HTML-only bodies into readable plain text", () => {
    expect(
      htmlToText(
        '<html><body><h1>Release shipped</h1><p>All checks <strong>passed</strong>.</p><br><a href="https://example.test">Details</a></body></html>',
      ),
    ).toBe("Release shipped\n\nAll checks passed.\nDetails");
  });

  it("strips scripts/styles and decodes common entities", () => {
    expect(
      htmlToText(
        "<style>.x{}</style><script>alert(1)</script><p>Tom &amp; Jerry&nbsp;&lt;team&gt;</p>",
      ),
    ).toBe("Tom & Jerry <team>");
  });
});

describe("extractAttachments", () => {
  it("returns empty array when no attachments", () => {
    expect(extractAttachments({ mimeType: "text/plain", body: { data: "x" } })).toEqual([]);
  });

  it("collects a single top-level attachment", () => {
    const result = extractAttachments({
      mimeType: "multipart/mixed",
      filename: "doc.pdf",
      body: { attachmentId: "att1", size: 1234 },
    });
    expect(result).toEqual([
      {
        id: "att1",
        filename: "doc.pdf",
        mimeType: "multipart/mixed",
        size: 1234,
      },
    ]);
  });

  it("walks nested parts and dedupes per-leaf", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: "x" } },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "a-1", size: 5 },
        },
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "image/png",
              filename: "logo.png",
              body: { attachmentId: "a-2", size: 10 },
            },
          ],
        },
      ],
    };
    expect(extractAttachments(payload)).toEqual([
      { id: "a-1", filename: "report.pdf", mimeType: "application/pdf", size: 5 },
      { id: "a-2", filename: "logo.png", mimeType: "image/png", size: 10 },
    ]);
  });

  it("substitutes default filename and mime type when missing", () => {
    const payload: GmailMessagePart = {
      body: { attachmentId: "anon", size: 0 },
    };
    expect(extractAttachments(payload)).toEqual([
      {
        id: "anon",
        filename: "attachment-anon",
        mimeType: "application/octet-stream",
        size: 0,
      },
    ]);
  });
});
