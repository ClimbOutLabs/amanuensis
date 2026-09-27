// search_emails wire output (operation level).
//
// Covers checklist #2: the wire output marks truncation explicitly
// (truncated:true + total_available + nextPageToken) and metadata rows carry
// no body/snippet duplication between text and structured content.

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../../../src/core/context.js";
import { registry } from "../../../src/core/registry.js";
// Side-effect import: registers search_emails.
import "../../../src/core/ops/messages.js";

function makeCtx(overrides: {
  list?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}): OperationContext {
  const oauth2Client = new OAuth2Client();
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  gmail.users.messages.list = overrides.list ?? vi.fn();
  gmail.users.messages.get = overrides.get ?? vi.fn();
  return {
    gmail,
    oauth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
  };
}

describe("search_emails wire output", () => {
  it("marks truncated:true on the wire when Gmail reports more pages (1.3)", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: {
        messages: [{ id: "m1", threadId: "t1" }],
        nextPageToken: "next-page",
        resultSizeEstimate: 42,
      },
    });
    const getMock = vi.fn().mockResolvedValue({
      data: { payload: { headers: [{ name: "Subject", value: "s" }] } },
    });
    const ctx = makeCtx({ list: listMock, get: getMock });

    const result = await registry.dispatch("search_emails", { query: "in:inbox" }, ctx);

    // listMeta reaches the wire: callers can tell the set was capped and how
    // to continue — no silent truncation.
    expect(result.structuredContent).toMatchObject({
      resultCount: 1,
      truncated: true,
      total_available: 42,
      nextPageToken: "next-page",
      resultSizeEstimate: 42,
    });
    // Metadata-only rows: no message bodies duplicated between text and
    // structured content.
    expect(result.structuredContent.results[0]).not.toHaveProperty("body");
    expect(result.structuredContent.results[0]).not.toHaveProperty("snippet");
  });
});
