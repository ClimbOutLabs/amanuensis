// Handler-level tests for src/core/ops/downloads.ts.
//
// Covers download_email handler integration across all four format branches,
// savePath mkdir when missing, download_attachment filename auto-lookup,
// savePath default cwd, safe-path sanitization, and DownloadAttachmentSchema parse.
//
// Strategy mirrors src/core/ops/messages.test.ts: side-effect import the op
// module so handlers register on the singleton registry, dispatch by name
// with a hand-rolled OperationContext whose `gmail` field is a deep nest of
// vi.fn() stubs. Files are written into a unique tmpdir per test and cleaned
// up in afterEach.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadAttachmentSchema } from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers downloadEmail / downloadAttachment.
import "./downloads.js";

function makeCtx(overrides: {
  messagesGet?: ReturnType<typeof vi.fn>;
  attachmentsGet?: ReturnType<typeof vi.fn>;
}): OperationContext {
  const messages = {
    get: overrides.messagesGet ?? vi.fn(),
    attachments: {
      get: overrides.attachmentsGet ?? vi.fn(),
    },
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

// Per-test tmpdir to keep filesystem assertions independent. It doubles as
// the downloads sandbox (GMAIL_DOWNLOADS_DIR) so savePath assertions exercise
// the real sandboxing path instead of bypassing it.
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-downloads-test-"));
  process.env.GMAIL_DOWNLOADS_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.GMAIL_DOWNLOADS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Shared message fixture for download_email cases.
const sampleHeaders = [
  { name: "Subject", value: "Test Email" },
  { name: "From", value: "Alice <alice@example.com>" },
  { name: "To", value: "bob@example.com" },
  { name: "Date", value: "Fri, 13 Mar 2026 10:00:00 +0000" },
];

function buildFullMessage(opts: { plain?: string; html?: string } = {}) {
  const { plain = "Hello plain", html = "<p>Hello HTML</p>" } = opts;
  return {
    data: {
      id: "msg-001",
      threadId: "thr-001",
      labelIds: ["INBOX"],
      snippet: "Hello plain",
      payload: {
        mimeType: "multipart/alternative",
        headers: sampleHeaders,
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from(plain, "utf8").toString("base64url") },
          },
          {
            mimeType: "text/html",
            body: { data: Buffer.from(html, "utf8").toString("base64url") },
          },
        ],
      },
    },
  };
}

describe("download_email handler (7.1-7.4)", () => {
  it("writes a JSON file with structured content + correct extension (7.1)", async () => {
    const getMock = vi.fn().mockResolvedValue(buildFullMessage());
    const ctx = makeCtx({ messagesGet: getMock });

    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-001", savePath: tmpDir, format: "json" },
      ctx,
    );

    const expectedPath = path.join(tmpDir, "msg-001.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    expect(parsed.messageId).toBe("msg-001");
    expect(parsed.subject).toBe("Test Email");
    expect(parsed.body.plain).toBe("Hello plain");
    expect(parsed.body.html).toBe("<p>Hello HTML</p>");

    expect(result.structuredContent).toMatchObject({
      status: "saved",
      path: expectedPath,
      messageId: "msg-001",
      subject: "Test Email",
      from: "Alice <alice@example.com>",
      format: "json",
    });
    expect(result.structuredContent!.size).toBeGreaterThan(0);

    // JSON branch should only fetch once (no separate raw fetch).
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith({ userId: "me", id: "msg-001", format: "full" }, { signal: undefined });
  });

  it("writes a .eml file by base64url-decoding the raw RFC822 fetch (7.2)", async () => {
    const rawBody = "Subject: Test Email\r\n\r\nbody text";
    const getMock = vi.fn().mockImplementation(async ({ format }: { format: string }) => {
      if (format === "raw") {
        return { data: { raw: Buffer.from(rawBody, "utf8").toString("base64url") } };
      }
      return buildFullMessage();
    });
    const ctx = makeCtx({ messagesGet: getMock });

    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-001", savePath: tmpDir, format: "eml" },
      ctx,
    );

    const expectedPath = path.join(tmpDir, "msg-001.eml");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe(rawBody);

    // Two fetches: full (for headers/attachments) + raw (for the body).
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledWith({ userId: "me", id: "msg-001", format: "raw" }, { signal: undefined });
    expect(result.structuredContent).toMatchObject({ format: "eml", path: expectedPath });
  });

  it("writes a .txt file containing extracted headers + body (7.3)", async () => {
    const getMock = vi.fn().mockResolvedValue(buildFullMessage({ plain: "Plain body content" }));
    const ctx = makeCtx({ messagesGet: getMock });

    await registry.dispatch(
      "download_email",
      { messageId: "msg-001", savePath: tmpDir, format: "txt" },
      ctx,
    );

    const expectedPath = path.join(tmpDir, "msg-001.txt");
    expect(fs.existsSync(expectedPath)).toBe(true);
    const txt = fs.readFileSync(expectedPath, "utf-8");
    expect(txt).toContain("Subject: Test Email");
    expect(txt).toContain("From: Alice <alice@example.com>");
    expect(txt).toContain("Plain body content");
  });

  it("writes an .html file with raw HTML, or returns a graceful failure when missing (7.4)", async () => {
    const okMock = vi.fn().mockResolvedValue(buildFullMessage({ html: "<h1>Header</h1>" }));
    const okCtx = makeCtx({ messagesGet: okMock });

    await registry.dispatch(
      "download_email",
      { messageId: "msg-001", savePath: tmpDir, format: "html" },
      okCtx,
    );

    const expectedPath = path.join(tmpDir, "msg-001.html");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe("<h1>Header</h1>");

    // Now no HTML in payload — handler should swallow the throw into a text-only error.
    const noHtmlMock = vi.fn().mockResolvedValue({
      data: {
        id: "msg-002",
        threadId: "thr-002",
        payload: {
          mimeType: "text/plain",
          headers: sampleHeaders,
          body: { data: Buffer.from("only plain", "utf8").toString("base64url") },
        },
      },
    });
    const failCtx = makeCtx({ messagesGet: noHtmlMock });
    const failResult = await registry.dispatch(
      "download_email",
      { messageId: "msg-002", savePath: tmpDir, format: "html" },
      failCtx,
    );
    expect(failResult.content[0].text).toContain("Failed to download email");
    expect(failResult.content[0].text).toContain("no HTML content");
    expect(failResult.structuredContent).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "msg-002.html"))).toBe(false);
  });
});

describe("download_email savePath mkdir (7.5)", () => {
  it("creates the save directory recursively when it doesn't exist", async () => {
    const nestedDir = path.join(tmpDir, "deep", "nested", "outdir");
    expect(fs.existsSync(nestedDir)).toBe(false);

    const getMock = vi.fn().mockResolvedValue(buildFullMessage());
    const ctx = makeCtx({ messagesGet: getMock });

    await registry.dispatch(
      "download_email",
      { messageId: "msg-001", savePath: nestedDir, format: "json" },
      ctx,
    );

    expect(fs.statSync(nestedDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(nestedDir, "msg-001.json"))).toBe(true);
  });
});

describe("download_attachment handler (7.7)", () => {
  const attachmentBytes = Buffer.from("PDF-DATA-bytes", "utf8");
  const attachmentB64 = attachmentBytes.toString("base64url");

  it("auto-resolves the filename from the message payload when not supplied", async () => {
    const attGet = vi.fn().mockResolvedValue({ data: { data: attachmentB64 } });
    const msgGet = vi.fn().mockResolvedValue({
      data: {
        payload: {
          parts: [
            { mimeType: "text/plain", body: { data: "aGVsbG8" } },
            {
              mimeType: "application/pdf",
              filename: "report.pdf",
              body: { attachmentId: "att-1", size: attachmentBytes.length },
            },
          ],
        },
      },
    });
    const ctx = makeCtx({ messagesGet: msgGet, attachmentsGet: attGet });

    const result = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1", savePath: tmpDir },
      ctx,
    );

    const expectedPath = path.join(tmpDir, "report.pdf");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath)).toEqual(attachmentBytes);

    expect(msgGet).toHaveBeenCalledWith({ userId: "me", id: "msg-001", format: "full" }, { signal: undefined });
    expect(result.structuredContent).toEqual({
      status: "saved",
      path: expectedPath,
      filename: "report.pdf",
      size: attachmentBytes.length,
      messageId: "msg-001",
      attachmentId: "att-1",
    });
  });

  it("also returns a picture attachment as an image block for the host, and nothing else", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pngCtx = makeCtx({ attachmentsGet: vi.fn().mockResolvedValue({ data: { data: png.toString("base64url") } }) });
    const picture = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1", savePath: tmpDir, filename: "photo.png" },
      pngCtx,
    );
    expect(picture.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });

    const pdfCtx = makeCtx({ attachmentsGet: vi.fn().mockResolvedValue({ data: { data: attachmentB64 } }) });
    const document = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1", savePath: tmpDir, filename: "report.pdf" },
      pdfCtx,
    );
    expect(document.content.every(block => block.type === "text")).toBe(true);
  });

  it("sanitizes a path-traversal filename via safeJoinWithinBase basename()", async () => {
    const attGet = vi.fn().mockResolvedValue({ data: { data: attachmentB64 } });
    const ctx = makeCtx({ attachmentsGet: attGet });

    const result = await registry.dispatch(
      "download_attachment",
      {
        messageId: "msg-001",
        attachmentId: "att-1",
        savePath: tmpDir,
        // Path traversal attempt — should be reduced to basename "evil.bin".
        filename: "../../../etc/evil.bin",
      },
      ctx,
    );

    const expectedPath = path.join(tmpDir, "evil.bin");
    expect(fs.existsSync(expectedPath)).toBe(true);
    // The escape attempt must NOT have written outside tmpDir.
    expect(fs.existsSync(path.join(tmpDir, "..", "..", "..", "etc", "evil.bin"))).toBe(false);
    expect(result.structuredContent).toMatchObject({
      path: expectedPath,
      filename: "evil.bin",
    });
    // Filename was supplied, so no extra messages.get lookup was needed.
    expect(ctx.gmail.users.messages.get).not.toHaveBeenCalled?.();
  });

  it("defaults savePath to the downloads sandbox dir when not provided", async () => {
    const attGet = vi.fn().mockResolvedValue({ data: { data: attachmentB64 } });
    const ctx = makeCtx({ attachmentsGet: attGet });

    // No savePath: the file must land in the sandbox (GMAIL_DOWNLOADS_DIR),
    // never in the process cwd.
    const result = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1", filename: "doc.bin" },
      ctx,
    );
    const expectedPath = path.join(tmpDir, "doc.bin");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      path: expectedPath,
      filename: "doc.bin",
    });
  });
});

describe("DownloadAttachmentSchema parse (7.20)", () => {  it("requires messageId and attachmentId; filename/savePath are optional", () => {    expect(DownloadAttachmentSchema.parse({ messageId: "m", attachmentId: "a" })).toEqual({
      messageId: "m",
      attachmentId: "a",
    });

    expect(
      DownloadAttachmentSchema.parse({
        messageId: "m",
        attachmentId: "a",
        filename: "x.bin",
        savePath: "/tmp",
      }),
    ).toEqual({
      messageId: "m",
      attachmentId: "a",
      filename: "x.bin",
      savePath: "/tmp",
    });

    expect(() => DownloadAttachmentSchema.parse({ attachmentId: "a" })).toThrow();
    expect(() => DownloadAttachmentSchema.parse({ messageId: "m" })).toThrow();
    expect(() => DownloadAttachmentSchema.parse({})).toThrow();
  });
});

