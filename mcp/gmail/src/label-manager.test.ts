// Low-level label-manager helpers — exercises the Gmail-API-mocked branches
// the op handlers depend on. Targets gaps 3.8 (system-label deletion refusal),
// 3.10 (case-insensitive findLabelByName), 3.11 (getOrCreateLabel cache-then-create),
// plus a happy-path createLabel sanity check.

import { describe, expect, it, vi } from "vitest";
import { createLabel, deleteLabel, findLabelByName, getOrCreateLabel } from "./label-manager.js";

// Helper: build a fake `gmail.users.labels.*` shim with the listed methods
// wired to vi.fn() so individual tests can program responses + assert calls.
function makeGmail(methods: Partial<Record<"list" | "get" | "create" | "delete" | "update", any>>) {
  return {
    users: {
      labels: {
        list: methods.list ?? vi.fn(),
        get: methods.get ?? vi.fn(),
        create: methods.create ?? vi.fn(),
        delete: methods.delete ?? vi.fn(),
        update: methods.update ?? vi.fn(),
      },
    },
  } as any;
}

describe("label-manager.createLabel", () => {
  it("forwards default visibility settings when options are omitted", async () => {
    const create = vi.fn().mockResolvedValue({
      data: { id: "Label_1", name: "Newsletters", type: "user" },
    });
    const gmail = makeGmail({ create });

    const result = await createLabel(gmail, "Newsletters");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        name: "Newsletters",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
      },
    }, { signal: undefined });
    expect(result).toMatchObject({ id: "Label_1", name: "Newsletters" });
  });
});

describe("label-manager.deleteLabel — SECURITY: system-label refusal", () => {
  it("refuses to delete a system label", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { id: "INBOX", name: "INBOX", type: "system" },
    });
    const del = vi.fn();
    const gmail = makeGmail({ get, delete: del });

    await expect(deleteLabel(gmail, "INBOX")).rejects.toThrow(
      /Cannot delete system label with ID "INBOX"/,
    );
    // Critical: the delete API must never be invoked for system labels.
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes a user label and returns success", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { id: "Label_42", name: "MyLabel", type: "user" },
    });
    const del = vi.fn().mockResolvedValue({});
    const gmail = makeGmail({ get, delete: del });

    const result = await deleteLabel(gmail, "Label_42");

    expect(del).toHaveBeenCalledWith({ userId: "me", id: "Label_42" }, { signal: undefined });
    expect(result).toEqual({
      success: true,
      message: 'Label "MyLabel" deleted successfully.',
    });
  });

  it("rewraps 404 from gmail.get into a friendly 'not found' error", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { code: 404 }));
    const gmail = makeGmail({ get });

    await expect(deleteLabel(gmail, "Label_missing")).rejects.toThrow(
      /Label with ID "Label_missing" not found/,
    );
  });
});

describe("label-manager.findLabelByName — case-insensitive search", () => {
  it("matches regardless of case", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_7", name: "ProjectAlpha", type: "user" },
        ],
      },
    });
    const gmail = makeGmail({ list });

    const lower = await findLabelByName(gmail, "projectalpha");
    const upper = await findLabelByName(gmail, "PROJECTALPHA");
    const mixed = await findLabelByName(gmail, "PrOjEcTaLpHa");

    expect(lower).toMatchObject({ id: "Label_7", name: "ProjectAlpha" });
    expect(upper).toMatchObject({ id: "Label_7", name: "ProjectAlpha" });
    expect(mixed).toMatchObject({ id: "Label_7", name: "ProjectAlpha" });
  });

  it("returns null when no label name matches", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
    });
    const gmail = makeGmail({ list });

    const found = await findLabelByName(gmail, "DoesNotExist");
    expect(found).toBeNull();
  });
});

describe("label-manager.getOrCreateLabel — cache-then-create flow", () => {
  it("returns the existing label without calling create when one is found", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        labels: [{ id: "Label_99", name: "CachedLabel", type: "user" }],
      },
    });
    const create = vi.fn();
    const gmail = makeGmail({ list, create });

    const result = await getOrCreateLabel(gmail, "CachedLabel");

    expect(result).toMatchObject({ id: "Label_99", name: "CachedLabel" });
    expect(list).toHaveBeenCalledTimes(1);
    // Cache hit must short-circuit before calling create.
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new label when no match is found in the cache", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
    });
    const create = vi.fn().mockResolvedValue({
      data: { id: "Label_new", name: "BrandNew", type: "user" },
    });
    const gmail = makeGmail({ list, create });

    const result = await getOrCreateLabel(gmail, "BrandNew", {
      messageListVisibility: "hide",
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        name: "BrandNew",
        messageListVisibility: "hide",
        labelListVisibility: "labelShow", // default fills in unset option
      },
    }, { signal: undefined });
    expect(result).toMatchObject({ id: "Label_new", name: "BrandNew" });
  });
});
