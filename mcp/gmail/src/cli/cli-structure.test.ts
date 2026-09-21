// Structural + error-path coverage for the gmail CLI surface. Focuses on
// commander wiring, the hidden --usage-spec short-circuit, the `tui` stub
// behaviour, the inbox alias positional/flag precedence, batch.ts --ids
// parsing, the download-email format validator, and the stdin (`-`) branch
// of resolveBodyInput. These are pure / commander-driven tests — none of
// them hit Gmail.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBatchDeleteCommand, buildBatchModifyCommand } from "./commands/batch.js";
import { buildDownloadEmailCommand } from "./commands/downloads.js";
import { buildInboxAliasCommand } from "./commands/threads.js";
import { buildTuiCommand } from "./commands/tui.js";
import { buildProgram, main } from "./index.js";
import { resolveBodyInput } from "./runtime.js";

// ────────────────────────────────────────────────────────────────────────
// 10.1 — buildProgram wires every subcommand
// ────────────────────────────────────────────────────────────────────────

describe("buildProgram (10.1)", () => {
  it("registers every expected subcommand", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();
    // The full CLI surface per `src/cli/index.ts` (modes + ops).
    const expected = [
      "account",
      "auth",
      "batch-delete",
      "batch-modify",
      "batch-report-phishing",
      "console",
      "delete",
      "delete-draft",
      "download-attachment",
      "download-email",
      "draft",
      "filters",
      "health",
      "identities",
      "inbox",
      "labels",
      "list-drafts",
      "mcp",
      "modify",
      "read",
      "reply-all",
      "report-phishing",
      "search",
      "send",
      "send-draft",
      "threads",
      "tui",
      "unread",
      "update-draft",
    ].sort();
    expect(names).toEqual(expected);
  });

  it("exposes a name and version on the program", () => {
    const program = buildProgram();
    expect(program.name()).toBe("gmail");
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.3 — main `--usage-spec` short-circuit
// ────────────────────────────────────────────────────────────────────────

describe("main --usage-spec (10.3)", () => {
  let writes: string[];
  let origWrite: typeof process.stdout.write;
  let origExit: typeof process.exit;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (
      chunk: unknown,
    ) => {
      writes.push(String(chunk));
      return true;
    };
    origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__exit_called__:${code ?? 0}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    process.exit = origExit;
  });

  it("dumps a KDL usage spec to stdout and exits 0", async () => {
    await expect(main(["node", "gmail", "--usage-spec"])).rejects.toThrow(/^__exit_called__:0$/);
    const out = writes.join("");
    // KDL spec from @usage-spec/commander begins with `name gmail` and lists
    // the `cmd mcp` / `cmd tui` declarations. We assert structural markers
    // rather than a byte-exact match.
    expect(out).toContain("name gmail");
    expect(out).toContain("cmd mcp");
    expect(out).toContain("cmd tui");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.6 — `gmail tui` stub graceful handling
// ────────────────────────────────────────────────────────────────────────

describe("buildTuiCommand (10.6)", () => {
  let stderr: string[];
  let origStderrWrite: typeof process.stderr.write;
  let origExit: typeof process.exit;

  beforeEach(() => {
    stderr = [];
    origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (
      chunk: unknown,
    ) => {
      stderr.push(String(chunk));
      return true;
    };
    origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__exit_called__:${code ?? 0}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  });

  it("refuses to start when stdout is not a TTY (vitest env) and prints a helpful hint", async () => {
    // Vitest captures stdout, so `process.stdout.isTTY` is undefined/false.
    // The TUI entry point detects this and refuses to start rather than
    // crashing inside Ink. Contract: it writes a TTY-required line on stderr
    // and exits with code 2 (auth/usage convention).
    const cmd = buildTuiCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(["node", "tui"])).rejects.toThrow(/^__exit_called__/);
    const out = stderr.join("");
    expect(out).toMatch(/requires an interactive terminal/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.11 — inbox alias positional vs --max precedence
// ────────────────────────────────────────────────────────────────────────

describe("buildInboxAliasCommand positional vs --max precedence (10.11)", () => {
  // We stub runtime.runCliOp via vi.mock so the action runs synchronously
  // without bootstrapping the Gmail client. We capture the args the command
  // would forward to the MCP dispatcher.
  let captured: Array<{ tool: string; args: unknown; opts: unknown }>;

  beforeEach(async () => {
    captured = [];
    vi.resetModules();
    vi.doMock("./runtime.js", async () => {
      const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
      return {
        ...actual,
        runCliOp: async (tool: string, args: unknown, opts: unknown) => {
          captured.push({ tool, args, opts });
        },
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  it("uses the positional argument over the default and over an absent --max", async () => {
    const { buildInboxAliasCommand: build } = await import("./commands/threads.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "inbox", "5"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].tool).toBe("list_inbox_threads");
    expect(captured[0].args).toMatchObject({ query: "in:inbox", maxResults: 5 });
  });

  it("falls back to --max when no positional is supplied", async () => {
    const { buildInboxAliasCommand: build } = await import("./commands/threads.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "inbox", "--max", "7"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args).toMatchObject({ maxResults: 7 });
  });

  it("falls back to the default (10) when neither positional nor --max is given", async () => {
    const { buildInboxAliasCommand: build } = await import("./commands/threads.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "inbox"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args).toMatchObject({ maxResults: 10 });
  });

  it("prefers the positional even when --max is also supplied", async () => {
    const { buildInboxAliasCommand: build } = await import("./commands/threads.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "inbox", "3", "--max", "99"]);
    expect(captured).toHaveLength(1);
    // Per source: `maxArg ?? options.max ?? 10` — positional wins.
    expect(captured[0].args).toMatchObject({ maxResults: 3 });
  });
});

// Touch buildInboxAliasCommand directly so the import doesn't get tree-shaken.
describe("buildInboxAliasCommand (shape)", () => {
  it("declares the optional positional + --max + --json flags", () => {
    const cmd = buildInboxAliasCommand();
    expect(cmd.name()).toBe("inbox");
    const flags = cmd.options.map((o) => o.long).filter(Boolean);
    expect(flags).toContain("--max");
    expect(flags).toContain("--json");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.17 — batch.ts --ids parser (CSV vs @file)
// ────────────────────────────────────────────────────────────────────────

describe("batch --ids parsing (10.17)", () => {
  let captured: Array<{ tool: string; args: any; opts: unknown }>;
  let tmpDir: string;

  beforeEach(async () => {
    captured = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-cli-batch-"));
    vi.resetModules();
    vi.doMock("./runtime.js", async () => {
      const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
      return {
        ...actual,
        runCliOp: async (tool: string, args: unknown, opts: unknown) => {
          captured.push({ tool, args: args as any, opts });
        },
      };
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.doUnmock("./runtime.js");
    vi.resetModules();
  });

  it("splits a comma-separated --ids string and trims whitespace", async () => {
    const { buildBatchModifyCommand: build } = await import("./commands/batch.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "batch-modify", "--ids", "abc, def ,ghi", "--add", "LBL_1"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args.messageIds).toEqual(["abc", "def", "ghi"]);
    expect(captured[0].args.addLabelIds).toEqual(["LBL_1"]);
  });

  it("reads newline-delimited IDs from @file and ignores blank lines", async () => {
    const idsFile = path.join(tmpDir, "ids.txt");
    fs.writeFileSync(idsFile, "msg1\nmsg2\n\n  msg3  \n");
    const { buildBatchDeleteCommand: build } = await import("./commands/batch.js");
    const cmd = build();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "batch-delete", "--ids", `@${idsFile}`]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args.messageIds).toEqual(["msg1", "msg2", "msg3"]);
  });
});

// Touch the direct exports so import-side errors surface immediately.
describe("buildBatchModifyCommand / buildBatchDeleteCommand (shape)", () => {
  it("registers --ids as a required option on both", () => {
    for (const cmd of [buildBatchModifyCommand(), buildBatchDeleteCommand()]) {
      const idsOpt = cmd.options.find((o) => o.long === "--ids");
      expect(idsOpt).toBeDefined();
      expect(idsOpt?.required).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.20 — download-email format validator
// ────────────────────────────────────────────────────────────────────────

describe("download-email format validator (10.20)", () => {
  it("rejects an unknown --format value", async () => {
    const cmd = buildDownloadEmailCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(["node", "download-email", "msg-id", "-o", "/tmp/out", "--format", "xml"]),
    ).rejects.toThrow(/Invalid format: xml/);
  });

  it("accepts a valid --format value (no throw at parse time)", async () => {
    // The action would eventually call runCliOp → Gmail; we stub it so
    // parseAsync resolves cleanly when the validator passes.
    vi.resetModules();
    vi.doMock("./runtime.js", async () => {
      const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
      return { ...actual, runCliOp: async () => {} };
    });
    try {
      const { buildDownloadEmailCommand: build } = await import("./commands/downloads.js");
      const cmd = build();
      cmd.exitOverride();
      await cmd.parseAsync([
        "node",
        "download-email",
        "msg-id",
        "-o",
        "/tmp/out",
        "--format",
        "eml",
      ]);
    } finally {
      vi.doUnmock("./runtime.js");
      vi.resetModules();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// 10.24 — resolveBodyInput stdin `-` branch
// ────────────────────────────────────────────────────────────────────────

describe("resolveBodyInput stdin (10.24)", () => {
  let origStdin: NodeJS.ReadableStream;

  beforeEach(() => {
    origStdin = process.stdin;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", {
      value: origStdin,
      configurable: true,
    });
  });

  it("reads the body from stdin when raw is '-'", async () => {
    const stub = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: stub,
      configurable: true,
    });
    const promise = resolveBodyInput("-");
    stub.write("hello ");
    stub.write("from stdin\n");
    stub.end();
    expect(await promise).toBe("hello from stdin\n");
  });
});
