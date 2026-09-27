// Operation-level sandbox enforcement for download_email / download_attachment.
//
// Covers checklist #2 at the operation layer (not just the safe-path helper):
// traversal and symlink-escape attempts in `savePath` must fail inside the
// configured downloads sandbox, must not write outside it, and must not issue
// any Gmail API call (the sandbox is resolved before the first request).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../../../src/core/context.js";
import { registry } from "../../../src/core/registry.js";
// Side-effect import: registers downloadEmail / downloadAttachment.
import "../../../src/core/ops/downloads.js";

function makeCtx(): { ctx: OperationContext; messagesGet: ReturnType<typeof vi.fn>; attachmentsGet: ReturnType<typeof vi.fn> } {
  // Real client instances (no casts): stub only the methods under test.
  const oauth2Client = new OAuth2Client();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const messagesGet = vi.fn();
  const attachmentsGet = vi.fn();
  gmail.users.messages.get = messagesGet;
  gmail.users.messages.attachments.get = attachmentsGet;
  const ctx: OperationContext = {
    gmail,
    oauth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
  };
  return { ctx, messagesGet, attachmentsGet };
}

let tmpDir: string;
let outsideDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-dl-sandbox-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-dl-outside-"));
  process.env.GMAIL_DOWNLOADS_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.GMAIL_DOWNLOADS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("download_email savePath sandbox (operation level)", () => {
  it("rejects a lexical traversal savePath without calling Gmail", async () => {
    const { ctx, messagesGet } = makeCtx();
    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-001", format: "txt", savePath: "../../etc" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(messagesGet).not.toHaveBeenCalled();
    // Nothing written outside the sandbox: the sandbox itself stays empty
    // and no sibling "etc" dir was created next to the tmp parent.
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(fs.existsSync(path.join(os.tmpdir(), "etc"))).toBe(false);
  });

  it("refuses a savePath through a symlink escaping the sandbox", async () => {
    const { ctx, messagesGet } = makeCtx();
    const link = path.join(tmpDir, "escape-link");
    fs.symlinkSync(outsideDir, link);
    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-001", format: "txt", savePath: "escape-link" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(messagesGet).not.toHaveBeenCalled();
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it("refuses a pre-planted file symlink at the destination", async () => {
    const { ctx, messagesGet } = makeCtx();
    messagesGet.mockResolvedValue({
      data: {
        payload: { headers: [] },
      },
    });
    const planted = path.join(tmpDir, "msg-002.txt");
    const target = path.join(outsideDir, "hijacked.txt");
    fs.symlinkSync(target, planted);
    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-002", format: "txt" },
      ctx,
    );
    expect(result.isError).toBe(true);
    // The symlink must not have been followed: no file outside the sandbox.
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("download_attachment savePath sandbox (operation level)", () => {
  it("rejects a traversal savePath without calling Gmail", async () => {
    const { ctx, messagesGet, attachmentsGet } = makeCtx();
    const result = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1", savePath: "../../etc" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(messagesGet).not.toHaveBeenCalled();
    expect(attachmentsGet).not.toHaveBeenCalled();
  });
});
