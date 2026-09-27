// Unit tests for src/filter-manager.ts.
//
// Covers golden-output tests on the static filterTemplates builders and
// 400 / 404 rewrap paths on the low-level CRUD helpers.
//
// The template builders are pure functions, so no mock is needed for those.
// The CRUD helpers take a `gmail` argument shaped like the googleapis Gmail
// client; we hand-roll a vi.fn() at the relevant path.

import { describe, expect, it, vi } from "vitest";
import {
  createFilter,
  deleteFilter,
  filterTemplates,
  getFilter,
  listFilters,
} from "./filter-manager.js";

describe("filterTemplates.fromSender (6.6)", () => {
  it("returns the from-only criteria with no removeLabelIds when archive is false", () => {
    expect(filterTemplates.fromSender("a@b.com", ["L1"], false)).toEqual({
      criteria: { from: "a@b.com" },
      action: { addLabelIds: ["L1"], removeLabelIds: undefined },
    });
  });

  it("removes the INBOX label when archive is true", () => {
    expect(filterTemplates.fromSender("a@b.com", ["L1"], true)).toEqual({
      criteria: { from: "a@b.com" },
      action: { addLabelIds: ["L1"], removeLabelIds: ["INBOX"] },
    });
  });

  it("defaults labelIds to [] and archive to false when omitted", () => {
    expect(filterTemplates.fromSender("solo@x.com")).toEqual({
      criteria: { from: "solo@x.com" },
      action: { addLabelIds: [], removeLabelIds: undefined },
    });
  });
});

describe("filterTemplates.withSubject (6.7)", () => {
  it("returns the subject-only criteria with no removeLabelIds when markAsRead is false", () => {
    expect(filterTemplates.withSubject("Invoice", ["L1"], false)).toEqual({
      criteria: { subject: "Invoice" },
      action: { addLabelIds: ["L1"], removeLabelIds: undefined },
    });
  });

  it("removes the UNREAD label when markAsRead is true", () => {
    expect(filterTemplates.withSubject("Invoice", ["L1"], true)).toEqual({
      criteria: { subject: "Invoice" },
      action: { addLabelIds: ["L1"], removeLabelIds: ["UNREAD"] },
    });
  });
});

describe("filterTemplates.withAttachments (6.8)", () => {
  it("emits hasAttachment=true with the supplied labels and no removeLabelIds", () => {
    expect(filterTemplates.withAttachments(["L1", "L2"])).toEqual({
      criteria: { hasAttachment: true },
      action: { addLabelIds: ["L1", "L2"] },
    });
  });

  it("defaults labelIds to [] when omitted", () => {
    expect(filterTemplates.withAttachments()).toEqual({
      criteria: { hasAttachment: true },
      action: { addLabelIds: [] },
    });
  });
});

describe("filterTemplates.largeEmails (6.9)", () => {
  it("emits size + sizeComparison='larger' and the supplied labels", () => {
    expect(filterTemplates.largeEmails(1_048_576, ["BIG"])).toEqual({
      criteria: { size: 1_048_576, sizeComparison: "larger" },
      action: { addLabelIds: ["BIG"] },
    });
  });
});

describe("filterTemplates.containingText (6.10)", () => {
  it("quotes the search text and does not add IMPORTANT when markImportant is false", () => {
    expect(filterTemplates.containingText("urgent", ["L1"], false)).toEqual({
      criteria: { query: '"urgent"' },
      action: { addLabelIds: ["L1"] },
    });
  });

  it("appends IMPORTANT to the addLabelIds when markImportant is true", () => {
    expect(filterTemplates.containingText("urgent", ["L1"], true)).toEqual({
      criteria: { query: '"urgent"' },
      action: { addLabelIds: ["L1", "IMPORTANT"] },
    });
  });
});

describe("filterTemplates.mailingList (6.11)", () => {
  it("builds a list: OR subject:[...] query and archives by default", () => {
    expect(filterTemplates.mailingList("dev@list.example")).toEqual({
      criteria: { query: "list:dev@list.example OR subject:[dev@list.example]" },
      action: { addLabelIds: [], removeLabelIds: ["INBOX"] },
    });
  });

  it("keeps the INBOX label when archive=false", () => {
    expect(filterTemplates.mailingList("dev@list.example", ["LIST"], false)).toEqual({
      criteria: { query: "list:dev@list.example OR subject:[dev@list.example]" },
      action: { addLabelIds: ["LIST"], removeLabelIds: undefined },
    });
  });
});

// ---------------------------------------------------------------------------
// Low-level CRUD rewrap paths (6.12, 6.14, 6.15).
// Each test constructs a gmail stub whose users.settings.filters.<method> is
// a vi.fn() that rejects with the error shape Gmail uses (code + message).
// ---------------------------------------------------------------------------

function makeGmail(method: "create" | "list" | "get" | "delete", fn: ReturnType<typeof vi.fn>) {
  return {
    users: {
      settings: {
        filters: {
          [method]: fn,
        },
      },
    },
  };
}

describe("createFilter (6.12)", () => {
  it("rewraps a 400 into a user-facing 'Invalid filter criteria or action' error", async () => {
    const err: any = new Error("bad criteria");
    err.code = 400;
    const fn = vi.fn().mockRejectedValue(err);
    const gmail = makeGmail("create", fn);

    await expect(createFilter(gmail, { from: "a@b.com" }, {})).rejects.toThrow(
      /Invalid filter criteria or action: bad criteria/,
    );
    expect(fn).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { criteria: { from: "a@b.com" }, action: {} },
    }, { signal: undefined });
  });

  it("rewraps a non-400 error into a generic 'Failed to create filter' message", async () => {
    const err: any = new Error("upstream boom");
    err.code = 500;
    const fn = vi.fn().mockRejectedValue(err);
    const gmail = makeGmail("create", fn);

    await expect(createFilter(gmail, {}, {})).rejects.toThrow(
      /Failed to create filter: upstream boom/,
    );
  });

  it("returns response.data on success", async () => {
    const fn = vi.fn().mockResolvedValue({ data: { id: "F1", criteria: {}, action: {} } });
    const gmail = makeGmail("create", fn);

    await expect(createFilter(gmail, {}, {})).resolves.toEqual({
      id: "F1",
      criteria: {},
      action: {},
    });
  });
});

describe("getFilter (6.14)", () => {
  it("rewraps a 404 into a 'not found' error citing the filter id", async () => {
    const err: any = new Error("nope");
    err.code = 404;
    const fn = vi.fn().mockRejectedValue(err);
    const gmail = makeGmail("get", fn);

    await expect(getFilter(gmail, "F-missing")).rejects.toThrow(
      /Filter with ID "F-missing" not found\./,
    );
    expect(fn).toHaveBeenCalledWith({ userId: "me", id: "F-missing" }, { signal: undefined });
  });

  it("rewraps non-404 into a generic 'Failed to get filter' message", async () => {
    const err: any = new Error("network down");
    err.code = 503;
    const fn = vi.fn().mockRejectedValue(err);
    const gmail = makeGmail("get", fn);

    await expect(getFilter(gmail, "F1")).rejects.toThrow(/Failed to get filter: network down/);
  });
});

describe("deleteFilter (6.15)", () => {
  it("rewraps a 404 into a 'not found' error citing the filter id", async () => {
    const err: any = new Error("nope");
    err.code = 404;
    const fn = vi.fn().mockRejectedValue(err);
    const gmail = makeGmail("delete", fn);

    await expect(deleteFilter(gmail, "F-missing")).rejects.toThrow(
      /Filter with ID "F-missing" not found\./,
    );
    expect(fn).toHaveBeenCalledWith({ userId: "me", id: "F-missing" }, { signal: undefined });
  });

  it("returns success message on the happy path", async () => {
    const fn = vi.fn().mockResolvedValue({ data: {} });
    const gmail = makeGmail("delete", fn);

    await expect(deleteFilter(gmail, "F1")).resolves.toEqual({
      success: true,
      message: 'Filter "F1" deleted successfully.',
    });
  });
});

describe("listFilters (6.13 — bonus)", () => {
  it("defaults to an empty array when the API omits the filter field", async () => {
    const fn = vi.fn().mockResolvedValue({ data: {} });
    const gmail = makeGmail("list", fn);

    await expect(listFilters(gmail)).resolves.toEqual({ filters: [], count: 0 });
  });
});
