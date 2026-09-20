/**
 * Behavioural tests for src/utl.ts — these complement the existing
 * source-grep tests in src/utl.test.ts with proper run-time assertions.
 *
 * Covered branches:
 *   4.14 createEmailMessage mimeType branches (text/plain, text/html, multipart/alternative)
 *   4.15 createEmailMessage RFC2047 subject encoding for non-ASCII
 *   4.16 createEmailMessage CRLF / NUL header sanitization (CRLF-injection guard)
 *   4.17 createEmailMessage invalid recipient throws
 *   4.18 createEmailWithNodemailer attachment-file-missing throws
 *   4.20 validateEmail truth-table
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailMessage, createEmailWithNodemailer, validateEmail } from "./utl.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getHeader(raw: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+)$`, "mi");
  const match = raw.match(regex);
  return match ? match[1].trim() : null;
}

function countHeader(raw: string, name: string): number {
  const regex = new RegExp(`^${name}:`, "gmi");
  return (raw.match(regex) ?? []).length;
}

// ---------------------------------------------------------------------------
// 4.14 mimeType branches
// ---------------------------------------------------------------------------

describe("createEmailMessage — mimeType branches (4.14)", () => {
  it("defaults to text/plain when mimeType is unset", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "Plain default",
      body: "hello",
    });
    expect(getHeader(raw, "Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(raw).not.toContain("multipart/alternative");
    expect(raw).toContain("hello");
  });

  it("emits a text/html email when mimeType=text/html and htmlBody is unset (body is rendered as HTML)", () => {
    // Per src/utl.ts:38, htmlBody + mimeType!=='text/plain' upgrades to
    // multipart/alternative. To exercise the pure `text/html` branch
    // (utl.ts:104-109) we must pass mimeType=text/html WITHOUT htmlBody —
    // the handler then renders `body` as HTML.
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "HTML only",
      body: "<p>fancy</p>",
      mimeType: "text/html",
    });
    expect(getHeader(raw, "Content-Type")).toBe("text/html; charset=UTF-8");
    expect(raw).toContain("<p>fancy</p>");
    expect(raw).not.toContain("multipart/alternative");
  });

  it("upgrades to multipart/alternative when htmlBody is provided and mimeType !== text/plain", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "Multi",
      body: "plain version",
      htmlBody: "<p>html version</p>",
      mimeType: "text/html", // triggers upgrade to multipart per src
    });
    const ct = getHeader(raw, "Content-Type");
    expect(ct).toMatch(/^multipart\/alternative; boundary="----=_NextPart_/);
    // Both bodies present, each in its own part
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Content-Type: text/html; charset=UTF-8");
    expect(raw).toContain("plain version");
    expect(raw).toContain("<p>html version</p>");
    // Closing boundary
    expect(raw).toMatch(/----=_NextPart_[a-z0-9]+--\s*$/);
  });

  it("stays text/plain (no multipart upgrade) even when htmlBody is set if mimeType=text/plain", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "Plain explicit",
      body: "stay plain",
      htmlBody: "<p>ignored</p>",
      mimeType: "text/plain",
    });
    expect(getHeader(raw, "Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(raw).not.toContain("multipart/alternative");
    expect(raw).not.toContain("<p>ignored</p>");
    expect(raw).toContain("stay plain");
  });
});

// ---------------------------------------------------------------------------
// 4.15 RFC2047 subject encoding
// ---------------------------------------------------------------------------

describe("createEmailMessage — RFC2047 subject encoding (4.15)", () => {
  it("encodes non-ASCII subjects as =?UTF-8?B?...?= base64", () => {
    const subject = "Héllo 世界 🚀";
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject,
      body: "x",
    });
    const expected = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
    expect(getHeader(raw, "Subject")).toBe(expected);
    // raw subject must not appear unencoded
    expect(raw).not.toContain("世界");
  });

  it("leaves ASCII-only subjects untouched", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "Plain ASCII Subject",
      body: "x",
    });
    expect(getHeader(raw, "Subject")).toBe("Plain ASCII Subject");
    expect(raw).not.toContain("=?UTF-8?B?");
  });
});

// ---------------------------------------------------------------------------
// 4.16 CRLF / NUL sanitization (header-injection guard — SECURITY)
// ---------------------------------------------------------------------------

describe("createEmailMessage — CRLF / NUL header sanitization (4.16)", () => {
  it("rejects CRLF-injection attempts in the To address before any header is built", () => {
    // Defence-in-depth: To addresses pass through validateEmail FIRST (utl.ts:46-50),
    // which rejects any address containing whitespace (incl. \r\n). This means
    // the classic header-injection payload `"victim@example.com\r\nBcc: evil@x.com"`
    // is refused outright — it never reaches the header serializer.
    expect(() =>
      createEmailMessage({
        to: ["victim@example.com\r\nBcc: evil@x.com"],
        subject: "Subj",
        body: "body",
      }),
    ).toThrow(/Recipient email address is invalid/);
  });

  it("strips NUL bytes and CRLF from the Subject and From headers", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      subject: "Hi\r\nX-Injected: 1\0nope",
      from: "me\r\nReply-To: evil@x.com",
      body: "b",
    });

    // No smuggled X-Injected header
    expect(raw).not.toMatch(/^X-Injected:/m);
    // No smuggled Reply-To header from the From field
    expect(raw).not.toMatch(/^Reply-To:/m);
    // From + Subject must each occupy exactly one header line
    expect(countHeader(raw, "From")).toBe(1);
    expect(countHeader(raw, "Subject")).toBe(1);
    // Subject contents have CR/LF/NUL stripped
    expect(getHeader(raw, "Subject")).toBe("HiX-Injected: 1nope");
    expect(getHeader(raw, "From")).toBe("meReply-To: evil@x.com");
  });

  it("strips CRLF from cc / bcc / inReplyTo / references", () => {
    const raw = createEmailMessage({
      to: ["a@example.com"],
      cc: ["c@example.com\r\nX-Smuggle: cc"],
      bcc: ["b@example.com\r\nX-Smuggle: bcc"],
      inReplyTo: "<a@x>\r\nX-Smuggle: irt",
      references: "<a@x>\r\nX-Smuggle: ref",
      subject: "s",
      body: "b",
    });
    expect(raw).not.toMatch(/^X-Smuggle:/m);
    expect(countHeader(raw, "Cc")).toBe(1);
    expect(countHeader(raw, "Bcc")).toBe(1);
    expect(countHeader(raw, "In-Reply-To")).toBe(1);
    expect(countHeader(raw, "References")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4.17 invalid recipient throws
// ---------------------------------------------------------------------------

describe("createEmailMessage — recipient validation (4.17)", () => {
  it("throws when a recipient is not a valid email", () => {
    expect(() =>
      createEmailMessage({
        to: ["not-an-email"],
        subject: "x",
        body: "y",
      }),
    ).toThrow(/Recipient email address is invalid: not-an-email/);
  });

  it("throws on the first invalid address in a mixed list", () => {
    expect(() =>
      createEmailMessage({
        to: ["good@example.com", "bad@@@", "also@example.com"],
        subject: "x",
        body: "y",
      }),
    ).toThrow(/bad@@@/);
  });
});

// ---------------------------------------------------------------------------
// 4.18 createEmailWithNodemailer attachment-file-missing throws
// ---------------------------------------------------------------------------

describe("createEmailWithNodemailer — attachments (4.18)", () => {
  const tmpFiles: string[] = [];
  const savedAttachmentsDir = process.env.GMAIL_ATTACHMENTS_DIR;
  beforeAll(() => {
    // The attachment sandbox only reads from GMAIL_ATTACHMENTS_DIR; these
    // fixtures already live directly in os.tmpdir(), so point the sandbox
    // there for this block.
    process.env.GMAIL_ATTACHMENTS_DIR = os.tmpdir();
  });
  afterAll(() => {
    if (savedAttachmentsDir === undefined) delete process.env.GMAIL_ATTACHMENTS_DIR;
    else process.env.GMAIL_ATTACHMENTS_DIR = savedAttachmentsDir;
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  });

  it("throws when an attachment path does not exist on disk", async () => {
    const missing = path.join(os.tmpdir(), `gmail-mcp-missing-${Date.now()}.bin`);
    // Make absolutely sure it doesn't exist
    try {
      fs.unlinkSync(missing);
    } catch {
      /* ignore */
    }

    await expect(
      createEmailWithNodemailer({
        to: ["a@example.com"],
        subject: "x",
        body: "y",
        attachments: [missing],
      }),
    ).rejects.toThrow(new RegExp(`File does not exist: ${missing.replace(/[.\\/]/g, "\\$&")}`));
  });

  it("produces a raw message when the attachment exists", async () => {
    const fp = path.join(os.tmpdir(), `gmail-mcp-fixture-${Date.now()}.txt`);
    fs.writeFileSync(fp, "fixture-content");
    tmpFiles.push(fp);

    const raw = await createEmailWithNodemailer({
      to: ["a@example.com"],
      subject: "Has attachment",
      body: "body",
      attachments: [fp],
    });
    expect(raw).toMatch(/Content-Disposition: attachment/);
    expect(raw).toMatch(/filename=/);
  });
});

// ---------------------------------------------------------------------------
// 4.20 validateEmail
// ---------------------------------------------------------------------------

describe("validateEmail (4.20)", () => {
  it.each([
    ["user@example.com", true],
    ["first.last+tag@sub.example.co.uk", true],
    ["a@b.c", true],
    ["", false],
    ["no-at-sign", false],
    ["double@@example.com", false],
    ["spaces in@example.com", false],
    ["trailing@example.com ", false],
    ["@example.com", false],
    ["user@", false],
    ["user@example", false], // no TLD dot
  ])("validateEmail(%j) === %s", (input, expected) => {
    expect(validateEmail(input)).toBe(expected);
  });
});
