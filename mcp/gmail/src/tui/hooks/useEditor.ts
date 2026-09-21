// External `$EDITOR` suspend flow. The hook returns a single function that
// callers await: write content to a persistent draft .eml file → suspend the
// Ink terminal (fullscreen.tsx renders an empty frame so nothing can paint
// over the editor) → release raw mode → spawn the editor with stdio:
// "inherit" → read the file back when the editor exits → resume the terminal.
//
// Draft persistence contract: this hook NEVER deletes the draft file. Every
// `:w` in the editor is an autosave to a stable path under
// `<configDir>/drafts/`, and the editor's own swapfile covers crash
// recovery. The caller (App.tsx) removes the draft only after the send /
// draft-save has verifiably succeeded; aborts and failures keep the file.
//
// The suspend-and-spawn pattern matches what aerc, mutt, and lazygit do.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getDraftsDir } from "../../core/config-paths.js";
import { resumeTerminal, suspendTerminal } from "../fullscreen.js";

export interface OpenEditorOptions {
  /** Initial content written to the draft file before the editor opens. */
  initialContent: string;
  /** Compose kind — prefixes the draft filename (`compose-…`, `reply-…`). */
  kind: string;
  /** Override editor binary. Otherwise: VISUAL → EDITOR → "vi". */
  editor?: string;
  /** Extension on the draft file — defaults to `.eml` so editor syntax highlighting kicks in. */
  extension?: string;
}

export interface OpenEditorResult {
  /** Content of the file after the editor exited. null if user aborted (non-zero exit). */
  content: string | null;
  /** Editor's exit code. */
  exitCode: number;
  /** Where the draft lives on disk. The file survives aborts and failures. */
  draftPath: string;
}

export type OpenEditor = (opts: OpenEditorOptions) => Promise<OpenEditorResult>;

export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || env.GMAIL_TUI_EDITOR?.trim() || "vi";
}

/** `2026-06-23-141530` — sortable, readable, filesystem-safe. */
function draftTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** First free `<kind>-<timestamp>[-n]<ext>` path under the drafts dir. */
async function allocateDraftPath(dir: string, kind: string, ext: string): Promise<string> {
  const base = `${kind}-${draftTimestamp()}`;
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, `${base}${n === 0 ? "" : `-${n}`}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Factory — produces an `openEditor` function bound to the supplied
 * setRawMode callback. The hook itself doesn't depend on Ink; the wiring at
 * the App layer passes in `useStdin().setRawMode` so the editor can reclaim
 * the TTY cleanly.
 */
export function createEditorOpener(
  setRawMode: ((mode: boolean) => void) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenEditor {
  return async ({ initialContent, kind, editor, extension = ".eml" }) => {
    const draftsDir = getDraftsDir(env);
    await fs.mkdir(draftsDir, { recursive: true });
    const draftPath = await allocateDraftPath(draftsDir, kind, extension);
    await fs.writeFile(draftPath, initialContent, "utf8");

    const bin = (editor ?? resolveEditor(env)).trim();

    // Suspend first: after this resolves, Ink has flushed an empty frame and
    // cannot repaint (resize included) until resumeTerminal(). Then release
    // the raw-mode lock and pause stdin so the editor gets a clean TTY.
    await suspendTerminal();
    try {
      if (setRawMode) setRawMode(false);
      process.stdin.pause();

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(bin, [draftPath], {
          stdio: "inherit",
          env: { ...env },
          shell: false,
        });
        child.on("error", (err) => {
          reject(err);
        });
        child.on("exit", (code, signal) => {
          if (signal) {
            resolve(128 + (signalToNumber(signal) ?? 1));
            return;
          }
          resolve(code ?? 0);
        });
      });

      if (exitCode !== 0) {
        return { content: null, exitCode, draftPath };
      }
      const content = await fs.readFile(draftPath, "utf8");
      return { content, exitCode, draftPath };
    } finally {
      try {
        process.stdin.resume();
      } catch {
        // ignore
      }
      if (setRawMode) setRawMode(true);
      await resumeTerminal();
    }
  };
}

function signalToNumber(sig: NodeJS.Signals): number | null {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[sig] ?? null;
}
