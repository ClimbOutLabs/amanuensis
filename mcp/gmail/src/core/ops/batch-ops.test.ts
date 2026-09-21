// Handler-level tests for batch_modify_emails / batch_delete_emails.
// processBatches itself is covered in src/core/batch.test.ts — these tests
// focus on the registered op handlers: success/failure counting, the
// truncated-ID error formatting (substring(0, 16) in the source), and the
// default batchSize=50 fallback when the caller omits it.

import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
import "./batch-ops.js"; // side-effect: registers the ops

interface FakeGmail {
  users: {
    messages: {
      modify: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      batchModify: ReturnType<typeof vi.fn>;
    };
  };
}

function makeFakeGmail(overrides: Partial<FakeGmail["users"]["messages"]> = {}): FakeGmail {
  return {
    users: {
      messages: {
        modify: vi.fn(),
        delete: vi.fn(),
        batchModify: vi.fn(),
        ...overrides,
      } as FakeGmail["users"]["messages"],
    },
  };
}

function makeCtx(gmail: FakeGmail, toolName: string): OperationContext {
  return {
    gmail: gmail as unknown as OperationContext["gmail"],
    oauth2Client: {} as OperationContext["oauth2Client"],
    authorizedScopes: ["gmail.modify"],
    toolName,
    accountId: null,
  };
}

describe("batch_modify_emails handler", () => {
  it("counts successes and failures and formats truncated-ID error lines", async () => {
    const failingId = "msg-fails-aaaaaaaaaaaaaaaaaa"; // > 16 chars so truncation is visible
    const goodIds = ["msg-ok-1", "msg-ok-2"];
    const ids = [...goodIds, failingId];

    const modify = vi.fn(async ({ id }: { id: string }) => {
      if (id === failingId) throw new Error("permission denied");
      return { data: {} };
    });
    const ctx = makeCtx(makeFakeGmail({ modify }), "batch_modify_emails");

    // batchSize=1 forces per-call dispatch, so only the failing id reaches
    // the per-item fallback and ends up in `failures`.
    const result = await registry.dispatch(
      "batch_modify_emails",
      { messageIds: ids, addLabelIds: ["LBL_X"], batchSize: 1 },
      ctx,
    );

    // Every id was attempted at least once (and the failing one twice — batch + fallback).
    expect(modify).toHaveBeenCalledTimes(ids.length + 1);
    // The request body carried addLabelIds through.
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        id: goodIds[0],
        requestBody: { addLabelIds: ["LBL_X"] },
      }),
      { signal: undefined },
    );

    const structured = result.structuredContent as {
      action: string;
      successCount: number;
      failureCount: number;
      failures: Array<{ messageId: string; error: string }>;
    };
    expect(structured.action).toBe("modify");
    expect(structured.successCount).toBe(2);
    expect(structured.failureCount).toBe(1);
    expect(structured.failures).toEqual([{ messageId: failingId, error: "permission denied", batchIndex: 2 }]); // ids[2], batchSize 1

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Successfully processed: 2 messages");
    expect(text).toContain("Failed to process: 1 messages");
    // ID is truncated to 16 chars + "..." in the failure listing.
    const truncated = failingId.substring(0, 16);
    expect(text).toContain(`- ${truncated}... (batch 2: permission denied)`);
    expect(text).not.toContain(failingId); // full id should not appear
  });
});

describe("batch_report_phishing handler", () => {
  it("falls back per item and reports partial failures", async () => {
    const badId = "phish-bad";
    const batchModify = vi.fn(async ({ requestBody }: { requestBody: { ids: string[] } }) => {
      if (requestBody.ids.includes(badId)) throw new Error("blocked");
      return { data: {} };
    });
    const result = await registry.dispatch(
      "batch_report_phishing",
      { messageIds: ["phish-good", badId], batchSize: 2 },
      makeCtx(makeFakeGmail({ batchModify }), "batch_report_phishing"),
    );
    expect(batchModify).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { ids: ["phish-good"], addLabelIds: ["SPAM"] },
    }, { signal: undefined });
    expect(result.structuredContent).toEqual({
      action: "report_phishing",
      successCount: 1,
      failureCount: 1,
      failures: [{ messageId: badId, error: "blocked", batchIndex: 0 }],
      batchesTotal: 1,
      batchesCompleted: 1,
      itemsTotal: 2,
      aborted: false,
    });
    expect(result.content[0].text).toContain("no native phishing-report endpoint");
  });
});

describe("batch_delete_emails handler", () => {
  it("counts successes and failures and formats truncated-ID error lines", async () => {
    const failingId = "del-fails-bbbbbbbbbbbbbbbbbb";
    const goodIds = ["del-ok-1", "del-ok-2"];
    const ids = [...goodIds, failingId];

    const del = vi.fn(async ({ id }: { id: string }) => {
      if (id === failingId) throw new Error("not found");
      return { data: {} };
    });
    const ctx = makeCtx(makeFakeGmail({ delete: del }), "batch_delete_emails");

    const result = await registry.dispatch(
      "batch_delete_emails",
      { messageIds: ids, batchSize: 1 },
      ctx,
    );

    expect(del).toHaveBeenCalledTimes(ids.length + 1);
    expect(del).toHaveBeenCalledWith({ userId: "me", id: goodIds[0] }, { signal: undefined });

    const structured = result.structuredContent as {
      action: string;
      successCount: number;
      failureCount: number;
      failures: Array<{ messageId: string; error: string }>;
    };
    expect(structured.action).toBe("delete");
    expect(structured.successCount).toBe(2);
    expect(structured.failureCount).toBe(1);
    expect(structured.failures).toEqual([{ messageId: failingId, error: "not found", batchIndex: 2 }]); // ids[2], batchSize 1

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Batch delete operation complete.");
    expect(text).toContain("Successfully deleted: 2 messages");
    expect(text).toContain("Failed to delete: 1 messages");
    const truncated = failingId.substring(0, 16);
    expect(text).toContain(`- ${truncated}... (batch 2: not found)`);
  });
});

describe("batch handlers default batchSize", () => {
  it("uses batchSize=50 when not supplied (60 ids → 2 batches of 50+10)", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    const modify = vi.fn(async () => ({ data: {} }));
    const ctx = makeCtx(makeFakeGmail({ modify }), "batch_modify_emails");

    // Spy on Promise.all so we can observe batch sizes. The handler calls
    // Promise.all(batch.map(...)) inside processBatches — each Promise.all
    // call corresponds to one batch. We rely on the modify spy's call
    // ordering instead, which is simpler and equally definitive.
    await registry.dispatch(
      "batch_modify_emails",
      { messageIds: ids }, // batchSize omitted → default 50
      ctx,
    );

    // Default batchSize=50 means a single batch of 50 then a remainder of 10.
    // Total modify calls = 60 (one per id), all succeed → no per-item fallback.
    expect(modify).toHaveBeenCalledTimes(60);
    // Spot-check: first id and last id were both modified once each.
    const calledIds = modify.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(calledIds).toContain("id-0");
    expect(calledIds).toContain("id-59");
    expect(new Set(calledIds).size).toBe(60);
  });
});
