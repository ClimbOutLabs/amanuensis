// Download failure envelopes (operation level).
//
// Covers checklist #2: Gmail fetch failures, attachment fetch failures, and
// message lookup failures each return `isError: true` envelopes (never a
// throw, never a partial success).

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

function makeCtx(overrides: {
  messagesGet?: ReturnType<typeof vi.fn>;
  attachmentsGet?: ReturnType<typeof vi.fn>;
}): { ctx: OperationContext; messagesGet: ReturnType<typeof vi.fn>; attachmentsGet: ReturnType<typeof vi.fn> } {
  const oauth2Client = new OAuth2Client();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const messagesGet = overrides.messagesGet ?? vi.fn();
  const attachmentsGet = overrides.attachmentsGet ?? vi.fn();
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
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-dl-errors-"));
  process.env.GMAIL_DOWNLOADS_DIR = tmpDir;
});
afterEach(() => {
  delete process.env.GMAIL_DOWNLOADS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("download failure envelopes", () => {
  it("download_email returns isError:true when the Gmail fetch fails", async () => {
    const messagesGet = vi.fn().mockRejectedValue(new Error("boom-fetch"));
    const { ctx } = makeCtx({ messagesGet });
    const result = await registry.dispatch(
      "download_email",
      { messageId: "msg-001", format: "json" },
      ctx,
    );
    expect(messagesGet).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Failed to download email");
    expect(result.content[0]?.text).toContain("boom-fetch");
  });

  it("download_attachment returns isError:true when the attachment fetch fails", async () => {
    const attachmentsGet = vi.fn().mockRejectedValue(new Error("boom-attachment"));
    const { ctx } = makeCtx({ attachmentsGet });
    const result = await registry.dispatch(
      "download_attachment",
      { messageId: "msg-001", attachmentId: "att-1" },
      ctx,
    );
    expect(attachmentsGet).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Failed to download attachment");
    expect(result.content[0]?.text).toContain("boom-attachment");
  });

  it("download_attachment returns isError:true when the message lookup fails", async () => {
    const messagesGet = vi.fn().mockRejectedValue(new Error("boom-lookup"));
    const { ctx } = makeCtx({ messagesGet });
    const result = await registry.dispatch(
      "download_attachment",
      { messageId: "missing", attachmentId: "att-1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Failed to download attachment");
  });
});
