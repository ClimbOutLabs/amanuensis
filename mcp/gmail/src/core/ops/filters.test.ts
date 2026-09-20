// Handler-level tests for src/core/ops/filters.ts.
//
// Covers filter op handlers. The most important branch is
// create_filter_from_template's 6-way switch + the missing-required-param
// throws + the unreachable-by-schema default throw.
//
// Strategy: import the module so the ops register themselves on the singleton
// registry, then dispatch by name with a hand-rolled OperationContext whose
// `gmail.users.settings.filters.*` is a deep nest of vi.fn() stubs. The
// default-case throw on the template switch can only be reached by bypassing
// the zod enum, so that one branch invokes the handler directly off the
// registry entry.

import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { CreateFilterFromTemplateSchema } from "../../tools.js";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
// Side-effect import: registers the 5 filter ops on the singleton registry.
import "./filters.js";

function makeCtx(overrides: {
  create?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): OperationContext {
  const filters = {
    create: overrides.create ?? vi.fn(),
    list: overrides.list ?? vi.fn(),
    get: overrides.get ?? vi.fn(),
    delete: overrides.delete ?? vi.fn(),
  };
  const gmail = {
    users: { settings: { filters } },
  } as unknown as gmail_v1.Gmail;
  return {
    gmail,
    oauth2Client: {} as OAuth2Client,
    authorizedScopes: ["https://www.googleapis.com/auth/gmail.settings.basic"],
    toolName: "test",
    accountId: "default",
  };
}

describe("create_filter handler (6.1)", () => {
  it("creates the filter and formats criteria/action text + structuredContent", async () => {
    const createMock = vi.fn().mockResolvedValue({ data: { id: "F-new" } });
    const ctx = makeCtx({ create: createMock });

    const result = await registry.dispatch(
      "create_filter",
      {
        criteria: { from: "a@b.com", subject: "Invoice" },
        action: { addLabelIds: ["L1"], removeLabelIds: [] },
      },
      ctx,
    );

    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { from: "a@b.com", subject: "Invoice" },
        action: { addLabelIds: ["L1"], removeLabelIds: [] },
      },
    }, { signal: undefined });
    expect(result.content[0].text).toContain("ID: F-new");
    expect(result.content[0].text).toContain("from: a@b.com");
    expect(result.content[0].text).toContain("subject: Invoice");
    // removeLabelIds=[] should be filtered out of the formatted action line.
    expect(result.content[0].text).toContain("addLabelIds: L1");
    expect(result.content[0].text).not.toContain("removeLabelIds:");
    expect(result.structuredContent).toEqual({
      id: "F-new",
      criteria: { from: "a@b.com", subject: "Invoice" },
      action: { addLabelIds: ["L1"], removeLabelIds: [] },
    });
  });
});

describe("list_filters handler (6.2)", () => {
  it("short-circuits to a 'No filters found.' message when the API returns none", async () => {
    const listMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ list: listMock });

    const result = await registry.dispatch("list_filters", {}, ctx);

    expect(listMock).toHaveBeenCalledWith({ userId: "me" }, { signal: undefined });
    expect(result.content[0].text).toBe("No filters found.");
    expect(result.structuredContent).toEqual({
      count: 0,
      filters: [],
      truncated: false,
      total_available: 0,
    });
  });

  it("renders each filter and populates structuredContent.filters when results are present", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: {
        filter: [
          {
            id: "F1",
            criteria: { from: "x@y" },
            action: { addLabelIds: ["L"] },
          },
        ],
      },
    });
    const ctx = makeCtx({ list: listMock });

    const result = await registry.dispatch("list_filters", {}, ctx);

    expect(result.content[0].text).toContain("Found 1 filters");
    expect(result.content[0].text).toContain("ID: F1");
    expect(result.structuredContent).toEqual({
      count: 1,
      truncated: false,
      total_available: 1,
      filters: [
        {
          id: "F1",
          criteria: { from: "x@y" },
          action: { addLabelIds: ["L"] },
        },
      ],
    });
  });
});

describe("get_filter handler (6.3)", () => {
  it("fetches the filter and renders both text + structuredContent", async () => {
    const getMock = vi.fn().mockResolvedValue({
      data: { id: "F2", criteria: { subject: "hi" }, action: { addLabelIds: ["A"] } },
    });
    const ctx = makeCtx({ get: getMock });

    const result = await registry.dispatch("get_filter", { filterId: "F2" }, ctx);

    expect(getMock).toHaveBeenCalledWith({ userId: "me", id: "F2" }, { signal: undefined });
    expect(result.content[0].text).toContain("ID: F2");
    expect(result.content[0].text).toContain("subject: hi");
    expect(result.structuredContent).toEqual({
      id: "F2",
      criteria: { subject: "hi" },
      action: { addLabelIds: ["A"] },
    });
  });
});

describe("delete_filter handler (6.4)", () => {
  it("deletes the filter and returns the success message + structuredContent", async () => {
    const delMock = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx({ delete: delMock });

    const result = await registry.dispatch("delete_filter", { filterId: "F3" }, ctx);

    expect(delMock).toHaveBeenCalledWith({ userId: "me", id: "F3" }, { signal: undefined });
    expect(result.content[0].text).toBe('Filter "F3" deleted successfully.');
    expect(result.structuredContent).toEqual({
      id: "F3",
      status: "deleted",
      message: 'Filter "F3" deleted successfully.',
    });
  });
});

describe("create_filter_from_template handler (6.5)", () => {
  // Helper: stub create to capture the requestBody so we can assert the
  // template-built criteria/action were forwarded verbatim.
  function setup() {
    const createMock = vi.fn().mockResolvedValue({ data: { id: "F-tpl" } });
    const ctx = makeCtx({ create: createMock });
    return { createMock, ctx };
  }

  it("routes 'fromSender' through filterTemplates.fromSender", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      {
        template: "fromSender",
        parameters: { senderEmail: "a@b.com", labelIds: ["L1"], archive: true },
      },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { from: "a@b.com" },
        action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
      },
    }, { signal: undefined });
  });

  it("routes 'withSubject' through filterTemplates.withSubject", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      {
        template: "withSubject",
        parameters: { subjectText: "Invoice", labelIds: ["L"], markAsRead: true },
      },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { subject: "Invoice" },
        action: { addLabelIds: ["L"], removeLabelIds: ["UNREAD"] },
      },
    }, { signal: undefined });
  });

  it("routes 'withAttachments' through filterTemplates.withAttachments", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      { template: "withAttachments", parameters: { labelIds: ["ATT"] } },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { hasAttachment: true },
        action: { addLabelIds: ["ATT"] },
      },
    }, { signal: undefined });
  });

  it("routes 'largeEmails' through filterTemplates.largeEmails", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      {
        template: "largeEmails",
        parameters: { sizeInBytes: 1_048_576, labelIds: ["BIG"] },
      },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { size: 1_048_576, sizeComparison: "larger" },
        action: { addLabelIds: ["BIG"] },
      },
    }, { signal: undefined });
  });

  it("routes 'containingText' through filterTemplates.containingText (markImportant=true appends IMPORTANT)", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      {
        template: "containingText",
        parameters: { searchText: "urgent", labelIds: ["L"], markImportant: true },
      },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { query: '"urgent"' },
        action: { addLabelIds: ["L", "IMPORTANT"] },
      },
    }, { signal: undefined });
  });

  it("routes 'mailingList' through filterTemplates.mailingList", async () => {
    const { createMock, ctx } = setup();
    await registry.dispatch(
      "create_filter_from_template",
      {
        template: "mailingList",
        parameters: { listIdentifier: "dev@list.example", labelIds: ["LIST"], archive: false },
      },
      ctx,
    );
    expect(createMock).toHaveBeenCalledWith({
      userId: "me",
      requestBody: {
        criteria: { query: "list:dev@list.example OR subject:[dev@list.example]" },
        action: { addLabelIds: ["LIST"], removeLabelIds: undefined },
      },
    }, { signal: undefined });
  });

  it.each([
    ["fromSender", { labelIds: [] }, /senderEmail is required for fromSender/],
    ["withSubject", { labelIds: [] }, /subjectText is required for withSubject/],
    ["largeEmails", { labelIds: [] }, /sizeInBytes is required for largeEmails/],
    ["containingText", { labelIds: [] }, /searchText is required for containingText/],
    ["mailingList", { labelIds: [] }, /listIdentifier is required for mailingList/],
  ])(
    "rejects '%s' when the required parameter is missing",
    async (template, parameters, expected) => {
      const { createMock, ctx } = setup();
      await expect(
        registry.dispatch("create_filter_from_template", { template, parameters }, ctx),
      ).rejects.toThrow(expected);
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown templates with 'Unknown template: <name>' (default-case throw)", async () => {
    // The zod enum on CreateFilterFromTemplateSchema makes this branch
    // unreachable via registry.dispatch (the schema parse step rejects first).
    // Invoke the handler directly off the registry entry to exercise the
    // defensive default-case throw — it's still real code on the prod path.
    const { createMock, ctx } = setup();
    const op = registry.get("create_filter_from_template");
    expect(op).toBeDefined();
    await expect(op!.handler({ template: "bogus", parameters: {} }, ctx)).rejects.toThrow(
      /Unknown template: bogus/,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("the zod enum on the schema rejects unknown template names before dispatch", () => {
    expect(() =>
      CreateFilterFromTemplateSchema.parse({ template: "bogus", parameters: {} }),
    ).toThrow();
  });
});
