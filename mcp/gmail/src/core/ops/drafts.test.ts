import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { ListDraftsOutputSchema } from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
import "./drafts.js";

function context(drafts: Record<string, ReturnType<typeof vi.fn>>): OperationContext {
  return {
    gmail: { users: { drafts } } as unknown as gmail_v1.Gmail,
    oauth2Client: {} as OperationContext["oauth2Client"],
    authorizedScopes: ["gmail.compose"],
    toolName: "draft-test",
    accountId: null,
  };
}

describe("draft lifecycle operations", () => {
  it("draft_email exposes draftId while retaining messageId", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "d1" } });
    const result = await registry.dispatch(
      "draft_email",
      { to: ["to@example.com"], subject: "Subject", body: "Body" },
      context({ create }),
    );
    expect(result.structuredContent).toEqual({
      messageId: "d1",
      draftId: "d1",
      action: "drafted",
      threadId: undefined,
    });
  });

  it("send_draft uses drafts.send and returns the sent message", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "m1", threadId: "t1" } });
    const result = await registry.dispatch("send_draft", { draftId: "d1" }, context({ send }));
    expect(send).toHaveBeenCalledWith({ userId: "me", requestBody: { id: "d1" } }, { signal: undefined });
    expect(result.structuredContent).toEqual({
      draftId: "d1",
      messageId: "m1",
      threadId: "t1",
      status: "sent",
    });
  });

  it("update_draft replaces MIME content in place", async () => {
    const update = vi.fn().mockResolvedValue({
      data: { id: "d1", message: { id: "m-draft", threadId: "t1" } },
    });
    const result = await registry.dispatch(
      "update_draft",
      {
        draftId: "d1",
        to: ["to@example.com"],
        subject: "Updated",
        body: "New body",
        threadId: "t1",
      },
      context({ update }),
    );
    const request = update.mock.calls[0]?.[0] as {
      requestBody: { message: { raw: string; threadId: string } };
    };
    const decoded = Buffer.from(request.requestBody.message.raw, "base64url").toString("utf8");
    expect(decoded).toContain("Subject: Updated");
    expect(decoded).toContain("New body");
    expect(request.requestBody.message.threadId).toBe("t1");
    expect(result.structuredContent).toEqual({
      draftId: "d1",
      messageId: "m-draft",
      threadId: "t1",
      status: "updated",
    });
  });

  it("delete_draft uses drafts.delete", async () => {
    const del = vi.fn().mockResolvedValue({ data: {} });
    const result = await registry.dispatch(
      "delete_draft",
      { draftId: "d1" },
      context({ delete: del }),
    );
    expect(del).toHaveBeenCalledWith({ userId: "me", id: "d1" }, { signal: undefined });
    expect(result.structuredContent).toEqual({ draftId: "d1", status: "deleted" });
  });

  it("list_drafts enriches each stub with metadata via a per-draft get", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        drafts: [
          { id: "d1", message: { id: "m1", threadId: "t1" } },
          { id: "d2", message: { id: "m2" } },
        ],
        resultSizeEstimate: 2,
      },
    });
    const get = vi.fn().mockImplementation(async ({ id }: { id: string }) => {
      const byId: Record<string, unknown> = {
        d1: {
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            snippet: "first draft snippet",
            payload: {
              headers: [
                { name: "Subject", value: "First draft" },
                { name: "From", value: "me@example.com" },
                { name: "To", value: "a@example.com, b@example.com" },
                { name: "Date", value: "Mon, 03 Nov 2025 09:00:00 +0000" },
              ],
            },
          },
        },
        d2: {
          id: "d2",
          message: {
            id: "m2",
            snippet: "second draft snippet",
            payload: { headers: [{ name: "Subject", value: "Second draft" }] },
          },
        },
      };
      return { data: byId[id] };
    });

    const result = await registry.dispatch("list_drafts", {}, context({ list, get }));
    expect(list).toHaveBeenCalledWith({ userId: "me" }, { signal: undefined });
    // format:"metadata" keeps each per-draft fetch body-free.
    expect(get).toHaveBeenCalledWith({ userId: "me", id: "d1", format: "metadata" }, { signal: undefined });

    // The structured payload validates against the declared output schema.
    const parsed = ListDraftsOutputSchema.parse(result.structuredContent);
    expect(parsed.resultCount).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.total_available).toBe(2);
    expect(parsed.drafts[0]).toEqual({
      draftId: "d1",
      messageId: "m1",
      threadId: "t1",
      subject: "First draft",
      from: "me@example.com",
      to: ["a@example.com", "b@example.com"],
      date: "Mon, 03 Nov 2025 09:00:00 +0000",
      snippet: "first draft snippet",
    });
    // A draft with no threadId / recipients degrades cleanly.
    expect(parsed.drafts[1]).toMatchObject({ draftId: "d2", subject: "Second draft", to: [] });
    expect(parsed.drafts[1]?.threadId).toBeUndefined();
  });

  it("list_drafts forwards paging args and marks truncation from nextPageToken", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        drafts: [{ id: "d9", message: { id: "m9" } }],
        resultSizeEstimate: 40,
        nextPageToken: "PAGE2",
      },
    });
    const get = vi.fn().mockResolvedValue({
      data: { id: "d9", message: { id: "m9", snippet: "", payload: { headers: [] } } },
    });
    const result = await registry.dispatch(
      "list_drafts",
      { maxResults: 1, pageToken: "PAGE1" },
      context({ list, get }),
    );
    expect(list).toHaveBeenCalledWith({ userId: "me", maxResults: 1, pageToken: "PAGE1" }, { signal: undefined });
    const parsed = ListDraftsOutputSchema.parse(result.structuredContent);
    expect(parsed.nextPageToken).toBe("PAGE2");
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_available).toBe(40);
  });
});
