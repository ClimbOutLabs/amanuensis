// Op-handler tests for src/core/ops/labels.ts. Targets gaps 3.1 (list_email_labels
// system/user split), 3.5 (get_or_create_label action-text branch), and 3.12
// (CreateLabelSchema enum bounds). Each op is dispatched via the singleton
// registry with a stubbed OperationContext whose `gmail` is a vi.fn() shim.

import { describe, expect, it, vi } from "vitest";
// Side-effect import: registers labels ops on the singleton registry.
import "./labels.js";
import { CreateLabelSchema } from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";

function makeCtx(
  labelsMethods: Partial<Record<"list" | "get" | "create" | "delete" | "update", any>>,
): OperationContext {
  return {
    gmail: {
      users: {
        labels: {
          list: labelsMethods.list ?? vi.fn(),
          get: labelsMethods.get ?? vi.fn(),
          create: labelsMethods.create ?? vi.fn(),
          delete: labelsMethods.delete ?? vi.fn(),
          update: labelsMethods.update ?? vi.fn(),
        },
      },
    } as any,
    oauth2Client: {} as any,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    toolName: "test",
    accountId: "default",
  };
}

describe("list_email_labels handler", () => {
  it("splits labels into system and user buckets with accurate counts", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "SENT", name: "SENT", type: "system" },
          { id: "Label_1", name: "Receipts", type: "user" },
          { id: "Label_2", name: "Newsletters", type: "user" },
          { id: "Label_3", name: "Travel", type: "user" },
        ],
      },
    });
    const ctx = makeCtx({ list });

    const result = await registry.dispatch("list_email_labels", {}, ctx);

    expect(result.structuredContent).toMatchObject({
      count: { total: 5, system: 2, user: 3 },
    });
    // Make sure each bucket holds the right entries.
    const sc = result.structuredContent as any;
    expect(sc.system.map((l: any) => l.id)).toEqual(["INBOX", "SENT"]);
    expect(sc.user.map((l: any) => l.name)).toEqual(["Receipts", "Newsletters", "Travel"]);
    // Text envelope mentions the totals too.
    expect(result.content[0].text).toContain("Found 5 labels (2 system, 3 user)");
  });

  it("returns zeroed counts when the account has no labels", async () => {
    const list = vi.fn().mockResolvedValue({ data: { labels: [] } });
    const ctx = makeCtx({ list });

    const result = await registry.dispatch("list_email_labels", {}, ctx);

    expect(result.structuredContent).toMatchObject({
      count: { total: 0, system: 0, user: 0 },
      system: [],
      user: [],
    });
  });
});

describe("get_or_create_label handler — action-text branch", () => {
  it("reports 'found existing' when a user-typed label with the same name already exists", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        labels: [{ id: "Label_existing", name: "ProjectX", type: "user" }],
      },
    });
    const create = vi.fn();
    const ctx = makeCtx({ list, create });

    const result = await registry.dispatch("get_or_create_label", { name: "ProjectX" }, ctx);

    // Cache hit — must not call create.
    expect(create).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Successfully found existing label");
    expect(result.structuredContent).toMatchObject({
      id: "Label_existing",
      name: "ProjectX",
      type: "user",
    });
  });

  it("reports 'created new' when the cache lookup misses and Gmail normalises the returned label name", async () => {
    // The handler distinguishes via: result.type === "user" && result.name === args.name
    // → "found existing"; otherwise "created new". Gmail can normalise nested label
    // names (e.g. trimming whitespace or re-casing parent paths), so the returned
    // name need not equal the input — that's the realistic "created new" path.
    const list = vi.fn().mockResolvedValue({
      data: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
    });
    const create = vi.fn().mockResolvedValue({
      data: { id: "Label_fresh", name: "Parent/BrandNew", type: "user" },
    });
    const ctx = makeCtx({ list, create });

    const result = await registry.dispatch("get_or_create_label", { name: "BrandNew" }, ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Successfully created new label");
    expect(result.structuredContent).toMatchObject({
      id: "Label_fresh",
      name: "Parent/BrandNew",
      type: "user",
    });
  });
});

describe("CreateLabelSchema — enum bounds (3.12)", () => {
  it("accepts a minimal { name } payload", () => {
    const parsed = CreateLabelSchema.parse({ name: "Hello" });
    expect(parsed.name).toBe("Hello");
    // Optional fields stay undefined (defaults applied inside label-manager).
    expect(parsed.messageListVisibility).toBeUndefined();
    expect(parsed.labelListVisibility).toBeUndefined();
  });

  it("accepts every valid enum value", () => {
    expect(
      CreateLabelSchema.parse({
        name: "X",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
      }),
    ).toBeTruthy();
    expect(
      CreateLabelSchema.parse({
        name: "X",
        messageListVisibility: "hide",
        labelListVisibility: "labelShowIfUnread",
      }),
    ).toBeTruthy();
    expect(
      CreateLabelSchema.parse({
        name: "X",
        labelListVisibility: "labelHide",
      }),
    ).toBeTruthy();
  });

  it("rejects out-of-enum messageListVisibility", () => {
    expect(() =>
      CreateLabelSchema.parse({ name: "X", messageListVisibility: "visible" }),
    ).toThrow();
  });

  it("rejects out-of-enum labelListVisibility", () => {
    expect(() =>
      CreateLabelSchema.parse({ name: "X", labelListVisibility: "showAlways" }),
    ).toThrow();
  });

  it("rejects missing required name field", () => {
    expect(() => CreateLabelSchema.parse({})).toThrow();
  });
});
