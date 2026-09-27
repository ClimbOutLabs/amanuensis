// Unit tests for the console REPL helpers. The interactive loop itself is
// covered by manual smoke tests (`gmail console` over a TTY); these tests
// focus on the pure helpers + the REPL-mode flag round-trip in runtime.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBuiltinCommand, parseConsoleInput, rewriteAlias } from "./console.js";
import { exitCli, runCliOp } from "./runtime.js";

describe("parseConsoleInput", () => {
  it("splits a simple command line on whitespace", () => {
    expect(parseConsoleInput("inbox 10")).toEqual({ cmd: "inbox", args: ["10"] });
  });

  it("preserves double-quoted strings as single tokens", () => {
    expect(parseConsoleInput('search "from:noreply newer_than:7d"')).toEqual({
      cmd: "search",
      args: ["from:noreply newer_than:7d"],
    });
  });

  it("preserves single-quoted strings as single tokens", () => {
    expect(parseConsoleInput("send -s 'A subject with spaces'")).toEqual({
      cmd: "send",
      args: ["-s", "A subject with spaces"],
    });
  });

  it("handles mixed quoted and unquoted tokens", () => {
    expect(parseConsoleInput('mod abc123 --add "Important,Work"')).toEqual({
      cmd: "mod",
      args: ["abc123", "--add", "Important,Work"],
    });
  });

  it("returns empty cmd for empty input", () => {
    expect(parseConsoleInput("")).toEqual({ cmd: "", args: [] });
    expect(parseConsoleInput("   ")).toEqual({ cmd: "", args: [] });
  });
});

describe("rewriteAlias", () => {
  it.each([
    ["i", "inbox"],
    ["s", "search"],
    ["r", "read"],
    ["ra", "reply-all"],
    ["d", "draft"],
    ["t", "threads"],
    ["mod", "modify"],
    ["del", "delete"],
    ["bm", "batch-modify"],
    ["bd", "batch-delete"],
    ["lab", "labels"],
    ["fil", "filters"],
    ["de", "download-email"],
    ["da", "download-attachment"],
    ["h", "health"],
    ["sw", "switch"],
  ])("rewrites %s → %s", (input, expected) => {
    expect(rewriteAlias(input)).toBe(expected);
  });

  it("passes unknown commands through unchanged", () => {
    expect(rewriteAlias("inbox")).toBe("inbox");
    expect(rewriteAlias("not-a-thing")).toBe("not-a-thing");
    expect(rewriteAlias("")).toBe("");
  });
});

describe("isBuiltinCommand", () => {
  it.each([
    "help",
    "?",
    "clear",
    "cls",
    "quit",
    "q",
    "exit",
    "tools",
    "raw",
    "accounts",
    "scope",
    "switch",
    "sw",
  ])("recognises `%s` as a built-in", (cmd) => {
    expect(isBuiltinCommand(cmd)).toBe(true);
  });

  it("rejects regular commands", () => {
    expect(isBuiltinCommand("inbox")).toBe(false);
    expect(isBuiltinCommand("search")).toBe(false);
    expect(isBuiltinCommand("")).toBe(false);
  });
});

describe("runCliOp REPL-mode flag", () => {
  let originalExit: typeof process.exit;
  let exitCalls: Array<number | undefined>;

  beforeEach(() => {
    exitCalls = [];
    originalExit = process.exit;
    // Capture process.exit calls without actually exiting the test runner.
    process.exit = ((code?: number) => {
      exitCalls.push(code);
      throw new Error(`__exit_called__:${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.GMAIL_CLI_REPL;
  });

  it("does not call process.exit when GMAIL_CLI_REPL=1", async () => {
    process.env.GMAIL_CLI_REPL = "1";
    // Invoke runCliOp with a bogus tool name. bootstrapForCli will throw
    // (no credentials in test env), executeCliOp catches + writes to stderr,
    // returns isError outcome, and runCliOp should NOT call process.exit
    // because REPL mode is active.
    await runCliOp("definitely_not_a_real_tool", {}, { json: false });
    expect(exitCalls).toEqual([]);
  });

  it("calls process.exit when GMAIL_CLI_REPL is unset", async () => {
    delete process.env.GMAIL_CLI_REPL;
    // Same setup; this time runCliOp should exit (we intercept via thrown
    // Error). The exact code may be 1, 2, or 3 depending on error classifier.
    await expect(runCliOp("definitely_not_a_real_tool", {}, { json: false })).rejects.toThrow(
      /^__exit_called__/,
    );
    expect(exitCalls.length).toBe(1);
  });

  it("exitCli throws replExit sentinel in REPL mode instead of process.exit", () => {
    // The actual production bug we just fixed: handlers like `health` called
    // process.exit directly, killing the console. exitCli now throws a tagged
    // Error under REPL mode so commander's parseAsync rejects and the console
    // catch keeps the loop alive.
    process.env.GMAIL_CLI_REPL = "1";
    try {
      exitCli(0);
      throw new Error("exitCli should have thrown");
    } catch (err) {
      const e = err as Error & { exitCode?: number; replExit?: boolean };
      expect(e.replExit).toBe(true);
      expect(e.exitCode).toBe(0);
    }
    expect(exitCalls).toEqual([]); // no process.exit
  });

  it("exitCli still calls process.exit in CLI mode", () => {
    delete process.env.GMAIL_CLI_REPL;
    expect(() => exitCli(3)).toThrow(/^__exit_called__:3$/);
    expect(exitCalls).toEqual([3]);
  });
});

// ── runConsole legend + REPL-driven built-ins ────────────────────────────
// These tests mock `node:readline.createInterface` so the loop can be driven
// from in-memory line queues instead of stdin. `runConsole` returns once the
// legend is rendered and bootstrap settles; the readline mock emits queued
// `line` events in order and signals completion via a resolver shared with the
// test.

describe("runConsole legend + REPL built-ins (11.7, 11.11, 11.12)", () => {
  type Line = string;
  let queuedLines: Line[];
  let doneResolve: (() => void) | null;
  let donePromise: Promise<void>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    queuedLines = [];
    doneResolve = null;
    donePromise = new Promise<void>((r) => {
      doneResolve = r;
    });
    // Capture writes to stdout/stderr without printing during tests.
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Guard against accidental process.exit (rl.on("close")) — readline mock
    // never emits close, but be defensive.
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__exit_called__:${code}`);
    }) as typeof process.exit;

    // Mock readline so runConsole can register a sequential `line` handler.
    // Once the handler is registered, dispatch the queued lines in order.
    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        on: (event: string, handler: (line?: string) => void | Promise<void>) => {
          if (event === "line") {
            queueMicrotask(async () => {
              while (queuedLines.length > 0) {
                await handler(queuedLines.shift());
              }
              doneResolve?.();
            });
          }
        },
        prompt: () => {},
        setPrompt: () => {},
        close: () => {},
      }),
    }));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exit = originalExit;
    vi.doUnmock("node:readline");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  it("`exit` closes readline and the next maybePrompt cycle no-ops cleanly", async () => {
    // Regression: prior to the `closed` flag in runConsole, calling
    // `rl.close()` from the `exit` built-in raced with the `.finally(maybePrompt)`
    // chain — readline would throw ERR_USE_AFTER_CLOSE from inside .resume().
    // The mock below mirrors that contract: prompt() throws if called after
    // close(), and close() fires registered close handlers.
    let closeHandler: (() => void) | null = null;
    let isClosed = false;
    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        on: (event: string, handler: (line?: string) => void | Promise<void>) => {
          if (event === "line") {
            queueMicrotask(async () => {
              while (queuedLines.length > 0) {
                await handler(queuedLines.shift());
              }
              doneResolve?.();
            });
          } else if (event === "close") {
            closeHandler = handler as () => void;
          }
        },
        prompt: () => {
          if (isClosed) {
            throw Object.assign(new Error("readline was closed"), {
              code: "ERR_USE_AFTER_CLOSE",
            });
          }
        },
        setPrompt: () => {},
        close: () => {
          isClosed = true;
          closeHandler?.();
        },
      }),
    }));

    queuedLines.push("exit");
    queuedLines.push("h"); // would crash on the post-close maybePrompt without the fix
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    await new Promise((r) => setTimeout(r, 20));

    // No ERR_USE_AFTER_CLOSE should have escaped to stderr.
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).not.toMatch(/ERR_USE_AFTER_CLOSE/);
    expect(stderrText).not.toMatch(/readline was closed/);
  });

  it("(11.7) renders the legend with section headers via the `write` injector", async () => {
    const writes: string[] = [];
    const write = (s: string) => {
      writes.push(s);
    };
    // No queued lines — the readline mock resolves donePromise immediately
    // after the line handler is registered.
    const { runConsole } = await import("./console.js");
    await runConsole({ write });
    await donePromise;

    const joined = writes.join("\n");
    // Header / title.
    expect(joined).toContain("gmail console");
    // Each section header from LEGEND_LINES.
    expect(joined).toMatch(/Read:/);
    expect(joined).toMatch(/Write:/);
    expect(joined).toMatch(/Manage:/);
    expect(joined).toMatch(/Debug:/);
    expect(joined).toMatch(/Session:/);
    // A couple of representative command rows so we know the loop iterated.
    expect(joined).toMatch(/i \[n\]/);
    expect(joined).toMatch(/raw <name> <json>/);
  });

  it("(11.11) `raw` with no tool name prints a usage hint without crashing", async () => {
    queuedLines.push("raw");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    // Give the microtask-deferred callback time to run.
    await new Promise((r) => setTimeout(r, 10));

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toMatch(/Usage: raw <toolName>/);
  });

  it("(11.11) `raw <tool> <bad-json>` reports invalid JSON without crashing", async () => {
    queuedLines.push("raw health_check {not valid json");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    await new Promise((r) => setTimeout(r, 10));

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toMatch(/Invalid JSON/);
  });

  it("(11.12) `tools` enumerates registered tool names from the registry", async () => {
    queuedLines.push("tools");
    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    // listTools awaits bootstrap + dynamic registry import; allow microtasks
    // to drain so its stdout writes land before we assert.
    await new Promise((r) => setTimeout(r, 50));

    const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    // The registry side-effect-loads every op when ../core/ops/index.js is
    // imported (which happens transitively via runConsole → bootstrapForCli
    // → main → src/index.ts). Spot-check a few well-known names.
    expect(stdoutText).toMatch(/health_check/);
    expect(stdoutText).toMatch(/search_emails/);
    expect(stdoutText).toMatch(/list_email_labels/);
  });

  it("`switch <id>` swaps the current console session via the switch_account tool", async () => {
    queuedLines.push("switch personal");
    const executeCliOp = vi.fn(async () => ({ isError: false }));
    vi.doMock("./runtime.js", () => ({
      bootstrapForCli: vi.fn(async () => {}),
      executeCliOp,
      callOp: vi.fn(async () => ({})),
    }));

    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });
    await donePromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(executeCliOp).toHaveBeenCalledWith(
      "switch_account",
      { accountId: "personal" },
      { json: false },
    );
  });
});

describe("runConsole piped line processing", () => {
  let lineHandler: ((line: string) => void | Promise<void>) | undefined;
  let closeHandler: (() => void) | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    lineHandler = undefined;
    closeHandler = undefined;
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__exit_called__:${code}`);
    }) as typeof process.exit;

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        on: (event: string, handler: (line?: string) => void | Promise<void>) => {
          if (event === "line") lineHandler = handler as (line: string) => void | Promise<void>;
          if (event === "close") closeHandler = handler as () => void;
        },
        prompt: () => {},
        close: () => {
          closeHandler?.();
        },
      }),
    }));
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exit = originalExit;
    vi.doUnmock("node:readline");
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  it("executes every piped line in order and exits cleanly on EOF", async () => {
    const executeCliOp = vi.fn(async () => ({
      result: { content: [{ type: "text", text: "ok" }], structuredContent: {} },
      isError: false,
    }));
    vi.doMock("./runtime.js", () => ({
      bootstrapForCli: vi.fn(async () => {}),
      executeCliOp,
      callOp: vi.fn(async () => ({})),
    }));

    const { runConsole } = await import("./console.js");
    await runConsole({ write: () => {} });

    expect(lineHandler).toBeTypeOf("function");
    await lineHandler?.("raw health_check {}");
    await lineHandler?.("accounts");
    await lineHandler?.("switch personal");

    // Lines are processed through an internal serial queue that the "line"
    // handler doesn't await, so poll until all three have been dispatched
    // instead of racing the queue.
    const deadline = Date.now() + 5000;
    while (executeCliOp.mock.calls.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(() => closeHandler?.()).not.toThrow();
    expect(executeCliOp).toHaveBeenNthCalledWith(1, "health_check", {}, { json: false });
    expect(executeCliOp).toHaveBeenNthCalledWith(2, "list_accounts", {}, { json: false });
    expect(executeCliOp).toHaveBeenNthCalledWith(
      3,
      "switch_account",
      { accountId: "personal" },
      { json: false },
    );
  });
});
