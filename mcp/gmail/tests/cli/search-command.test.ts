// L15: `gmail search` command integration — the --all streaming path and the
// default single-page path drive the mocked tool layer end to end (command
// parsing → paginate()/runCliOp → stdout), pinning the CLI wiring the
// paginate-guards helper tests don't cover.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolCalls: unknown[] = [];

function item(n: number) {
  return { id: `m${n}`, subject: `subject-${n}`, from: `from-${n}@x.com`, date: `date-${n}` };
}

vi.mock("../../src/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/index.js")>("../../src/index.js");
  return {
    ...actual,
    main: vi.fn(async () => {}),
    callMcpTool: vi.fn(async (_tool: string, args: unknown) => {
      toolCalls.push(args);
      const pageToken =
        typeof args === "object" && args !== null && "pageToken" in args
          ? String(args.pageToken)
          : undefined;
      const pages: Record<string, { items: unknown[]; nextPageToken?: string }> = {
        "": { items: [item(1), item(2)], nextPageToken: "p2" },
        p2: { items: [item(3)] },
      };
      const page = pages[pageToken ?? ""] ?? { items: [] };
      return {
        isError: false,
        content: [{ type: "text", text: "page text" }],
        structuredContent: {
          resultCount: page.items.length,
          results: page.items,
          nextPageToken: page.nextPageToken,
        },
      };
    }),
  };
});

import { buildSearchCommand } from "../../src/cli/commands/search.js";

let stdout = "";
let stderr = "";
let exitCode: number | undefined;

/**
 * Sentinel thrown by the process.exit mock. A mock implementation that
 * returns normally cannot satisfy process.exit's `never` return type without
 * a cast, so the mock throws instead — mirroring the REPL-mode `replExit`
 * sentinel in src/cli/runtime.ts. Tests that drive the exit path assert the
 * rejection and the recorded code.
 */
class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = "ExitCalled";
  }
}

beforeEach(() => {
  toolCalls.length = 0;
  stdout = "";
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  // Throws (inferred `never` return) rather than `return undefined as never`.
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new ExitCalled(typeof code === "number" ? code : undefined);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gmail search command", () => {
  it("streams every page with --all and prints all items as text", async () => {
    await buildSearchCommand().parseAsync(["node", "gmail", "hello", "--all"]);

    expect(toolCalls).toHaveLength(2);
    // Second call carries the page token from the first page.
    expect(toolCalls[1]).toMatchObject({ pageToken: "p2" });
    expect(stdout).toContain("subject-1");
    expect(stdout).toContain("subject-2");
    expect(stdout).toContain("subject-3");
    expect(stderr).toContain("3 result(s) across 2 page(s)");
  });

  it("takes the single-page runCliOp path by default", async () => {
    // runCliOp ends with process.exit(0); the mock throws ExitCalled.
    await expect(
      buildSearchCommand().parseAsync(["node", "gmail", "hello"]),
    ).rejects.toBeInstanceOf(ExitCalled);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ query: "hello", maxResults: 25 });
    expect(exitCode).toBe(0);
  });

  it("emits typed JSON on stdout with --all --json", async () => {
    await buildSearchCommand().parseAsync(["node", "gmail", "hello", "--all", "--json"]);

    const parsed: { resultCount: number; results: unknown[]; truncated: boolean } =
      JSON.parse(stdout);
    expect(parsed.resultCount).toBe(3);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.truncated).toBe(false);
  });
});
