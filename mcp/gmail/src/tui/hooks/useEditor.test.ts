// Validates the editor-suspend contract without actually spawning vim:
// stub child_process.spawn so we control the exit code + post-edit content,
// and stub the fullscreen module so no terminal escapes are written.
//
// Draft-persistence contract under test: the hook writes the draft to a
// persistent path under <configDir>/drafts/ and NEVER deletes it — success,
// abort, and error paths all leave the file on disk (App.tsx removes it
// only after a verified successful send).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../fullscreen.js", () => ({
  suspendTerminal: vi.fn(async () => {}),
  resumeTerminal: vi.fn(async () => {}),
}));

import * as cp from "node:child_process";
import { resumeTerminal, suspendTerminal } from "../fullscreen.js";
import { createEditorOpener, resolveEditor } from "./useEditor.js";

const mockedSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;
const mockedSuspend = suspendTerminal as unknown as ReturnType<typeof vi.fn>;
const mockedResume = resumeTerminal as unknown as ReturnType<typeof vi.fn>;

interface FakeChild {
  on: (event: string, cb: (...args: unknown[]) => void) => FakeChild;
}

function makeChild(
  exitCode: number,
  postEditContent: string | null,
  draftFileRef: { path: string | null },
): FakeChild {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child: FakeChild = {
    on: (event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      // Schedule the editor "exit" microtask so the awaiting Promise resolves.
      if (event === "exit") {
        setImmediate(async () => {
          // Simulate the user saving content before exit.
          if (postEditContent !== null && draftFileRef.path) {
            await fs.writeFile(draftFileRef.path, postEditContent, "utf8");
          }
          for (const fn of listeners.exit ?? []) fn(exitCode, null);
        });
      }
      return child;
    },
  };
  return child;
}

describe("resolveEditor", () => {
  it("prefers VISUAL then EDITOR then GMAIL_TUI_EDITOR then vi", () => {
    expect(resolveEditor({ VISUAL: "code", EDITOR: "vim" })).toBe("code");
    expect(resolveEditor({ EDITOR: "vim" })).toBe("vim");
    expect(resolveEditor({ GMAIL_TUI_EDITOR: "nano" })).toBe("nano");
    expect(resolveEditor({})).toBe("vi");
  });
});

describe("createEditorOpener", () => {
  let setRawMode: ReturnType<typeof vi.fn>;
  let origPause: typeof process.stdin.pause;
  let origResume: typeof process.stdin.resume;
  let configDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    setRawMode = vi.fn();
    mockedSpawn.mockReset();
    mockedSuspend.mockClear();
    mockedResume.mockClear();
    origPause = process.stdin.pause.bind(process.stdin);
    origResume = process.stdin.resume.bind(process.stdin);
    process.stdin.pause = vi.fn().mockReturnValue(process.stdin) as typeof process.stdin.pause;
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin) as typeof process.stdin.resume;
    // Point the drafts dir at a throwaway config dir — never ~/.gmail-mcp.
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-tui-editor-test-"));
    env = { EDITOR: "vim", GMAIL_CONFIG_DIR: configDir };
  });

  afterEach(async () => {
    process.stdin.pause = origPause;
    process.stdin.resume = origResume;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it("writes the draft under <configDir>/drafts/, spawns the editor, returns content + draftPath on exit 0", async () => {
    const draftFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((_bin: string, args: string[]) => {
      draftFileRef.path = args[0] ?? null;
      return makeChild(0, "edited body", draftFileRef);
    });
    const open = createEditorOpener(setRawMode, env);
    const result = await open({ initialContent: "draft", kind: "reply" });
    expect(result.exitCode).toBe(0);
    expect(result.content).toBe("edited body");
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(setRawMode).toHaveBeenCalledWith(true);
    // Draft path shape: <configDir>/drafts/reply-<timestamp>.eml
    expect(path.dirname(result.draftPath)).toBe(path.join(configDir, "drafts"));
    expect(path.basename(result.draftPath)).toMatch(/^reply-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.eml$/);
    // The hook never deletes the draft — success included.
    await expect(fs.readFile(result.draftPath, "utf8")).resolves.toBe("edited body");
  });

  it("suspends the terminal before spawning and resumes after", async () => {
    const draftFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((_bin: string, args: string[]) => {
      draftFileRef.path = args[0] ?? null;
      return makeChild(0, "x", draftFileRef);
    });
    const open = createEditorOpener(setRawMode, env);
    await open({ initialContent: "draft", kind: "compose" });
    expect(mockedSuspend).toHaveBeenCalledTimes(1);
    expect(mockedResume).toHaveBeenCalledTimes(1);
    const suspendOrder = mockedSuspend.mock.invocationCallOrder[0];
    const spawnOrder = mockedSpawn.mock.invocationCallOrder[0];
    const resumeOrder = mockedResume.mock.invocationCallOrder[0];
    expect(suspendOrder).toBeLessThan(spawnOrder);
    expect(spawnOrder).toBeLessThan(resumeOrder);
  });

  it("keeps the draft file when the editor exits non-zero (user aborted)", async () => {
    const draftFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((_bin: string, args: string[]) => {
      draftFileRef.path = args[0] ?? null;
      return makeChild(1, null, draftFileRef);
    });
    const open = createEditorOpener(setRawMode, env);
    const result = await open({ initialContent: "unsent words", kind: "reply" });
    expect(result.exitCode).toBe(1);
    expect(result.content).toBeNull();
    // The abort path preserves whatever was last written to disk.
    await expect(fs.readFile(result.draftPath, "utf8")).resolves.toBe("unsent words");
  });

  it("restores raw mode and resumes the terminal even when the editor errors out", async () => {
    mockedSpawn.mockImplementation(
      () =>
        ({
          on: (event: string, cb: (...args: unknown[]) => void) => {
            if (event === "error") setImmediate(() => cb(new Error("ENOENT")));
            return { on: () => ({}) };
          },
        }) as unknown as ReturnType<typeof cp.spawn>,
    );
    const open = createEditorOpener(setRawMode, {
      ...env,
      EDITOR: "definitely-not-an-editor",
    });
    await expect(open({ initialContent: "x", kind: "compose" })).rejects.toThrow(/ENOENT/);
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(mockedResume).toHaveBeenCalledTimes(1);
    // The pre-written draft survives the error, too.
    const drafts = await fs.readdir(path.join(configDir, "drafts"));
    expect(drafts).toHaveLength(1);
  });

  it("allocates distinct paths for same-second drafts of the same kind", async () => {
    const draftFileRef: { path: string | null } = { path: null };
    mockedSpawn.mockImplementation((_bin: string, args: string[]) => {
      draftFileRef.path = args[0] ?? null;
      return makeChild(1, null, draftFileRef);
    });
    const open = createEditorOpener(setRawMode, env);
    const a = await open({ initialContent: "one", kind: "compose" });
    const b = await open({ initialContent: "two", kind: "compose" });
    expect(a.draftPath).not.toBe(b.draftPath);
    await expect(fs.readFile(a.draftPath, "utf8")).resolves.toBe("one");
    await expect(fs.readFile(b.draftPath, "utf8")).resolves.toBe("two");
  });
});
