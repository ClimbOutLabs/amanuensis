// Pure-function tests for CLI runtime helpers. The bootstrap + dispatcher
// integration is covered end-to-end by manual smoke tests; this file exercises
// the helpers that touch input / output formatting.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callOp,
  exitCodeForError,
  formatToolResultText,
  printToolResult,
  resolveBodyInput,
  ToolCallError,
} from "./runtime.js";

describe("formatToolResultText", () => {
  it("joins multiple text fragments", () => {
    expect(
      formatToolResultText({
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      }),
    ).toBe("line 1\nline 2");
  });

  it("filters non-text fragments", () => {
    expect(
      formatToolResultText({
        content: [
          { type: "image", text: "should-not-appear" },
          { type: "text", text: "kept" },
        ],
      }),
    ).toBe("kept");
  });

  it("returns empty string for missing content", () => {
    expect(formatToolResultText({})).toBe("");
  });
});

describe("printToolResult", () => {
  it("emits structuredContent as JSON when --json", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      printToolResult(
        {
          content: [{ type: "text", text: "human readable" }],
          structuredContent: { foo: 42, bar: ["a", "b"] },
        },
        { json: true },
      );
    } finally {
      process.stdout.write = orig;
    }
    const out = writes.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ foo: 42, bar: ["a", "b"] });
  });

  it("falls back to wrapping text when no structuredContent", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      printToolResult({ content: [{ type: "text", text: "just text" }] }, { json: true });
    } finally {
      process.stdout.write = orig;
    }
    const out = writes.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ text: "just text" });
  });

  it("emits joined text when no --json", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      printToolResult(
        {
          content: [{ type: "text", text: "line a" }],
          structuredContent: { ignored: true },
        },
        { json: false },
      );
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toBe("line a\n");
  });
});

describe("exitCodeForError", () => {
  it("maps auth errors to 2", () => {
    expect(exitCodeForError(new Error("invalid_grant"))).toBe(2);
    expect(exitCodeForError(new Error("credentials missing"))).toBe(2);
    expect(exitCodeForError(new Error("Run gmail account auth work"))).toBe(2);
  });

  it("maps schema errors to 3", () => {
    expect(exitCodeForError(new Error("INVALID_SCOPE: foo"))).toBe(3);
    expect(exitCodeForError(new Error("invalid scope name"))).toBe(3);
    expect(exitCodeForError(new Error("Usage error: bad flag"))).toBe(3);
  });

  it("maps other errors to 1", () => {
    expect(exitCodeForError(new Error("network unreachable"))).toBe(1);
    expect(exitCodeForError(new Error("rate limited"))).toBe(1);
  });
});

describe("resolveBodyInput", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-cli-runtime-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when raw is undefined", async () => {
    expect(await resolveBodyInput(undefined)).toBeUndefined();
  });

  it("returns the string verbatim by default", async () => {
    expect(await resolveBodyInput("just a body")).toBe("just a body");
  });

  it("reads from a @file path", async () => {
    const filePath = path.join(tmpDir, "body.txt");
    fs.writeFileSync(filePath, "from-disk body\n");
    expect(await resolveBodyInput(`@${filePath}`)).toBe("from-disk body\n");
  });
});

// ---------------------------------------------------------------------------
// callOp + ToolCallError — typed in-process dispatch (Pre-TUI Step 2)
// ---------------------------------------------------------------------------
//
// Mocks `../index.js` so we can drive callMcpTool / main(skipTransport) without
// touching real credentials. Tests run hermetically.

vi.mock("../index.js", async () => {
  const stub = vi.fn();
  return {
    main: vi.fn(async () => undefined),
    callMcpTool: stub,
    __getStub: () => stub,
  };
});

describe("callOp (typed in-process dispatch)", () => {
  let callMcpToolStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = (await import("../index.js")) as unknown as {
      __getStub: () => ReturnType<typeof vi.fn>;
    };
    callMcpToolStub = mod.__getStub();
    callMcpToolStub.mockReset();
  });

  it("happy path: returns structuredContent typed as TOutput", async () => {
    interface InboxPayload {
      threadCount: number;
      threads: Array<{ id: string; subject: string }>;
    }
    const payload: InboxPayload = {
      threadCount: 1,
      threads: [{ id: "t1", subject: "hello" }],
    };
    callMcpToolStub.mockResolvedValueOnce({
      content: [{ type: "text", text: "ignored" }],
      structuredContent: payload,
      isError: false,
    });
    const result = await callOp<InboxPayload>("list_inbox_threads", { maxResults: 1 });
    expect(result).toEqual(payload);
    expect(callMcpToolStub).toHaveBeenCalledWith(
      "list_inbox_threads",
      { maxResults: 1 },
      undefined,
    );
  });

  it("throws ToolCallError when the dispatcher returns isError:true", async () => {
    callMcpToolStub.mockResolvedValueOnce({
      content: [{ type: "text", text: "scope missing: gmail.send" }],
      isError: true,
    });
    await expect(callOp("send_email", { to: ["x@y.z"] })).rejects.toBeInstanceOf(ToolCallError);

    callMcpToolStub.mockResolvedValueOnce({
      content: [{ type: "text", text: "scope missing: gmail.send" }],
      isError: true,
    });
    try {
      await callOp("send_email", { to: ["x@y.z"] });
    } catch (err) {
      expect((err as ToolCallError).toolName).toBe("send_email");
      expect((err as ToolCallError).message).toContain("scope missing");
    }
  });

  it("returns undefined when structuredContent is omitted (text-only ops)", async () => {
    callMcpToolStub.mockResolvedValueOnce({
      content: [{ type: "text", text: "Status: healthy" }],
      // structuredContent intentionally absent — modelling a text-only op.
      isError: false,
    });
    const result = await callOp<undefined>("legacy_text_op", {});
    expect(result).toBeUndefined();
  });
});
