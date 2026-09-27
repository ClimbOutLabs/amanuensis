// L15: CLI paginate() guards — hard caps, token-cycle detection, abort.
//
// The search/threads CLI commands stream pages through paginate(); these
// tests drive it with a mocked tool layer and pin every guard.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }));

const ArgsSchema = z.object({ pageToken: z.string().optional() });
const PageSchema = z.object({
  items: z.array(z.unknown()),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

vi.mock("../../src/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/index.js")>("../../src/index.js");
  return {
    ...actual,
    main: vi.fn(async () => {}),
    callMcpTool: vi.fn(async (_tool: string, args: unknown) => {
      calls.push(args);
      const pageToken = ArgsSchema.parse(args).pageToken;
      return pageScript(pageToken);
    }),
  };
});

// Page script: each test sets this to control the fake server.
let pageScript: (token: string | undefined) => unknown = () =>
  ({ isError: false, structuredContent: { items: [], nextPageToken: undefined } });

function setPages(pages: Array<{ items: unknown[]; nextPageToken?: string }>) {
  pageScript = (token) => {
    const idx = token === undefined ? 0 : Number(token);
    const page = pages[idx] ?? { items: [], nextPageToken: undefined };
    return {
      isError: false,
      structuredContent: {
        items: page.items,
        nextPageToken: page.nextPageToken,
        resultSizeEstimate: 999,
      },
    };
  };
}

import { paginate, PAGINATION_HARD_CAP, PAGINATION_MAX_PAGES } from "../../src/cli/runtime.js";

const baseOpts = {
  toolName: "search_emails",
  pageSize: 2,
  argsForPage: (pageToken: string | undefined) => ({ pageToken }),
  // Zod-validated instead of cast: the fake server speaks the same shape.
  // (paginate passes result.structuredContent straight to extract.)
  extract: (output: unknown) => {
    const page = PageSchema.parse(output);
    return {
      items: page.items,
      nextPageToken: page.nextPageToken,
      resultSizeEstimate: page.resultSizeEstimate,
    };
  },
};

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  pageScript = () => ({
    isError: false,
    structuredContent: { items: [], nextPageToken: undefined },
  });
});

describe("paginate guards (L15)", () => {
  it("stops once totalMax items are accumulated", async () => {
    setPages([
      { items: ["a", "b"], nextPageToken: "1" },
      { items: ["c", "d"], nextPageToken: "2" },
      { items: ["e"], nextPageToken: undefined },
    ]);
    const r = await paginate({ ...baseOpts, totalMax: 3 });
    expect(r.items).toEqual(["a", "b", "c"]);
    expect(r.hitTotalMax).toBe(true);
    expect(r.exhausted).toBe(false);
    expect(calls.length).toBe(2);
  });

  it("streams to the hard cap when totalMax is 0 and flags truncation", async () => {
    setPages([
      { items: ["a", "b"], nextPageToken: "1" },
      { items: ["c"], nextPageToken: undefined },
    ]);
    const r = await paginate({ ...baseOpts, totalMax: 0 });
    expect(r.items).toEqual(["a", "b", "c"]);
    expect(r.exhausted).toBe(true);
    expect(r.truncatedAtHardCap).toBe(false);
  });

  it("truncates at PAGINATION_HARD_CAP on an endless token stream", async () => {
    pageScript = (token) => {
      const idx = token === undefined ? 0 : Number(token);
      return {
        isError: false,
        structuredContent: {
          items: Array.from({ length: 100 }, (_, i) => `m${idx * 100 + i}`),
          nextPageToken: String(idx + 1),
        },
      };
    };
    const r = await paginate({ ...baseOpts, totalMax: 0 });
    expect(r.items.length).toBe(PAGINATION_HARD_CAP);
    expect(r.truncatedAtHardCap).toBe(true);
    // 50 pages of 100 items reach the item cap well before the page cap.
    expect(r.hitPageCap).toBe(false);
    expect(r.pageCount).toBe(50);
    expect(PAGINATION_MAX_PAGES).toBe(100);
  });

  it("bails on a repeating page token instead of looping", async () => {
    setPages([
      { items: ["a"], nextPageToken: "1" },
      { items: ["b"], nextPageToken: "1" }, // server replays token "1"
    ]);
    const r = await paginate({ ...baseOpts, totalMax: 0 });
    expect(r.repeatedPageToken).toBe(true);
    expect(r.items).toEqual(["a", "b"]);
    expect(calls.length).toBe(2);
  });

  it("honours an already-aborted signal without calling the tool", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await paginate({ ...baseOpts, totalMax: 0, signal: controller.signal });
    expect(r.items).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("surfaces tool errors as ToolCallError", async () => {
    pageScript = () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
      structuredContent: {},
    });
    await expect(paginate({ ...baseOpts, totalMax: 10 })).rejects.toThrow(/boom/);
  });

  it("records the first page's resultSizeEstimate", async () => {
    setPages([{ items: ["a"], nextPageToken: undefined }]);
    const r = await paginate({ ...baseOpts, totalMax: 0 });
    expect(r.resultSizeEstimate).toBe(999);
  });

  it("bails at PAGINATION_MAX_PAGES on empty pages with fresh tokens", async () => {
    // Empty pages never trip the item cap; only the page cap saves us.
    pageScript = (token) => {
      const idx = token === undefined ? 0 : Number(token);
      return {
        isError: false,
        structuredContent: { items: [], nextPageToken: String(idx + 1) },
      };
    };
    const r = await paginate({ ...baseOpts, totalMax: 0 });
    expect(r.hitPageCap).toBe(true);
    expect(r.pageCount).toBe(PAGINATION_MAX_PAGES);
    expect(r.truncatedAtHardCap).toBe(false);
  });
});
