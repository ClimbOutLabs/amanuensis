// Unit coverage for the GmailFixtureClient read paths added in Milestone D1:
// drafts.list / drafts.get (backed by the drafts/ corpus) and the existing
// messages.attachments.get. Exercised directly against the committed `full`
// fixture account without booting the dispatcher.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GmailFixtureClient } from "./gmail-fixture-client.js";

const FULL_ACCOUNT_DIR = fileURLToPath(new URL("../../fixtures/gmail/full", import.meta.url));

function client(): GmailFixtureClient {
  return new GmailFixtureClient(FULL_ACCOUNT_DIR);
}

describe("GmailFixtureClient drafts.*", () => {
  it("drafts.list returns lightweight stubs for every committed draft", async () => {
    const res = await client().users.drafts.list({ userId: "me" });
    const data = res.data as {
      drafts?: Array<{ id: string; message?: { id?: string; threadId?: string } }>;
      resultSizeEstimate?: number;
    };
    const ids = (data.drafts ?? []).map((d) => d.id).sort();
    expect(ids).toEqual(["f_draft_001", "f_draft_002"]);
    expect(data.resultSizeEstimate).toBe(2);
    // Stubs carry only the message id + threadId, not the full body.
    const first = (data.drafts ?? []).find((d) => d.id === "f_draft_001");
    expect(first?.message?.threadId).toBe("f_thr_006");
    expect((first?.message as { payload?: unknown } | undefined)?.payload).toBeUndefined();
  });

  it("drafts.list honours maxResults", async () => {
    const res = await client().users.drafts.list({ userId: "me", maxResults: 1 });
    const data = res.data as { drafts?: unknown[]; resultSizeEstimate?: number };
    expect(data.drafts).toHaveLength(1);
    // resultSizeEstimate reflects the full corpus, not the trimmed page.
    expect(data.resultSizeEstimate).toBe(2);
  });

  it("drafts.get returns the full draft with message body", async () => {
    const res = await client().users.drafts.get({ userId: "me", id: "f_draft_001" });
    const data = res.data as {
      id: string;
      message?: { threadId?: string; payload?: { body?: { data?: string } } };
    };
    expect(data.id).toBe("f_draft_001");
    expect(data.message?.threadId).toBe("f_thr_006");
    const body = Buffer.from(data.message?.payload?.body?.data ?? "", "base64").toString("utf8");
    expect(body).toMatch(/agenda to follow/i);
  });

  it("drafts.get throws a clear error for a missing draft", async () => {
    await expect(client().users.drafts.get({ userId: "me", id: "f_draft_404" })).rejects.toThrow(
      /not found|Fixture file not found/i,
    );
  });
});

describe("GmailFixtureClient messages.attachments.get", () => {
  it("returns the base64 attachment body for a committed attachment fixture", async () => {
    const res = await client().users.messages.attachments.get({
      userId: "me",
      messageId: "f_msg_003",
      id: "att_001",
    });
    const data = res.data as { data: string; size?: number };
    const decoded = Buffer.from(data.data, "base64").toString("utf8");
    expect(decoded).toMatch(/download_attachment coverage/);
    expect(Buffer.from(data.data, "base64").length).toBe(data.size);
  });
});
