/**
 * Tests for email threading header fixes (issue #66)
 *
 * Verifies:
 * 1. createEmailMessage uses separate `references` field when provided
 * 2. createEmailMessage falls back to `inReplyTo` for References when no `references` field
 * 3. No References/In-Reply-To headers on new emails
 * 4. Source verification: createEmailWithNodemailer uses references field
 * 5. Source verification: handleEmailAction auto-resolves threading headers
 * 6. Source verification: read_email returns Message-ID
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmailMessage, validateEmail } from "./utl.js";

// Resolve src directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

// Helper: extract a header value from a raw MIME message string
function getHeader(raw: string, headerName: string): string | null {
  const regex = new RegExp(`^${headerName}:\\s*(.+)$`, "mi");
  const match = raw.match(regex);
  return match ? match[1].trim() : null;
}

describe("Email threading headers", () => {
  it("uses separate references field when provided", () => {
    const args = {
      to: ["test@example.com"],
      subject: "Re: Thread test",
      body: "Reply body",
      inReplyTo: "<msg3@example.com>",
      references: "<msg1@example.com> <msg2@example.com> <msg3@example.com>",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBe(
      "<msg1@example.com> <msg2@example.com> <msg3@example.com>",
    );
    expect(getHeader(raw, "In-Reply-To")).toBe("<msg3@example.com>");
  });

  it("falls back to inReplyTo when references is absent", () => {
    const args = {
      to: ["test@example.com"],
      subject: "Re: Fallback test",
      body: "Reply body",
      inReplyTo: "<single@example.com>",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBe("<single@example.com>");
  });

  it("has no threading headers on new emails", () => {
    const args = {
      to: ["test@example.com"],
      subject: "New email",
      body: "Fresh email body",
    };
    const raw = createEmailMessage(args);

    expect(getHeader(raw, "References")).toBeNull();
    expect(getHeader(raw, "In-Reply-To")).toBeNull();
  });
});

describe("validateEmail — display-name recipients", () => {
  it("accepts bare addresses", () => {
    expect(validateEmail("a@b.com")).toBe(true);
    expect(validateEmail("first.last@sub.example.co.uk")).toBe(true);
  });

  it("accepts RFC-5322 display-name form (the reported bug)", () => {
    expect(validateEmail("Vahid Habibi <vahid.habibi@thebluerock.com.au>")).toBe(true);
    expect(validateEmail('"Last, First" <lf@example.com>')).toBe(true);
  });

  it("still rejects genuinely invalid recipients", () => {
    expect(validateEmail("")).toBe(false);
    expect(validateEmail("not-an-email")).toBe(false);
    expect(validateEmail("missing-tld@domain")).toBe(false);
    expect(validateEmail("two addresses@x.com y@z.com")).toBe(false);
  });
});

describe("createEmailMessage — display name preserved in header", () => {
  it("does not reject a Name <addr> recipient and keeps it verbatim in To:", () => {
    const raw = createEmailMessage({
      to: ["Vahid Habibi <vahid.habibi@thebluerock.com.au>"],
      subject: "Re: Disclaimer for Ads",
      body: "Sounds good.",
    });
    expect(getHeader(raw, "To")).toBe("Vahid Habibi <vahid.habibi@thebluerock.com.au>");
  });
});

describe("Source verification", () => {
  it("createEmailWithNodemailer uses references field with inReplyTo fallback", () => {
    const source = fs.readFileSync(path.join(srcDir, "utl.ts"), "utf-8");
    expect(source).toContain("references: validatedArgs.references || validatedArgs.inReplyTo");
  });

  it("handleEmailAction auto-resolves threading headers", () => {
    // handleEmailAction moved to src/core/ops/send.ts in Step 5 of the
    // modular refactor; it's the shared worker for send / draft / reply_all.
    const sendSource = fs.readFileSync(path.join(srcDir, "core", "ops", "send.ts"), "utf-8");
    expect(sendSource).toContain("validatedArgs.threadId && !validatedArgs.inReplyTo");
    expect(sendSource).toContain("gmail.users.threads.get");
    expect(sendSource).toContain("validatedArgs.inReplyTo = lastMessageId");
    expect(sendSource).toContain('validatedArgs.references = allMessageIds.join(" ")');
  });

  it("read_email returns Message-ID", () => {
    // read_email handler moved to src/core/ops/messages.ts in the Step 4
    // refactor; extractHeaders helper lives in src/core/email-helpers.ts.
    const messagesSrc = fs.readFileSync(path.join(srcDir, "core", "ops", "messages.ts"), "utf-8");
    const helpersSrc = fs.readFileSync(path.join(srcDir, "core", "email-helpers.ts"), "utf-8");
    expect(helpersSrc).toContain("message-id");
    expect(helpersSrc).toContain("rfcMessageId");
    expect(messagesSrc).toContain("Message-ID: ${rfcMessageId}");
  });
});
