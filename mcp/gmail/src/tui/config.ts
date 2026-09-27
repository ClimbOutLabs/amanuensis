// `~/.gmail-mcp/config.json` reader. Optional file; missing → all defaults.
// Env vars override file values:
//   GMAIL_TUI_THEME     → config.theme
//   GMAIL_TUI_EDITOR    → config.editor
//   GMAIL_TUI_CACHE_MB  → config.cacheMB
//
// Schema is permissive — unknown keys are kept (forward-compat) but never
// surfaced. Per-key Zod parsing keeps a single typo from breaking the entire
// load. Errors are logged but never thrown — the TUI must always boot.

import fs from "node:fs";
import path from "node:path";
import { warn as logWarn } from "@george43g/robustness";
import { getConfigDir } from "../core/config-paths.js";

export interface TuiConfig {
  theme: string;
  editor: string | undefined;
  cacheMB: number;
}

const DEFAULTS: TuiConfig = {
  theme: "default",
  editor: undefined,
  cacheMB: 50,
};

export function loadTuiConfig(env: NodeJS.ProcessEnv = process.env): TuiConfig {
  const dir = getConfigDir(env);
  const filePath = path.join(dir, "config.json");
  const fromFile = readConfigFile(filePath);
  return {
    theme: env.GMAIL_TUI_THEME?.trim() || fromFile.theme || DEFAULTS.theme,
    editor:
      env.GMAIL_TUI_EDITOR?.trim() || env.VISUAL?.trim() || env.EDITOR?.trim() || fromFile.editor,
    cacheMB: parseIntOr(env.GMAIL_TUI_CACHE_MB, fromFile.cacheMB ?? DEFAULTS.cacheMB),
  };
}

interface PartialConfig {
  theme?: string;
  editor?: string;
  cacheMB?: number;
}

function readConfigFile(file: string): PartialConfig {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const out: PartialConfig = {};
    if (typeof obj.theme === "string") out.theme = obj.theme;
    if (typeof obj.editor === "string") out.editor = obj.editor;
    if (typeof obj.cacheMB === "number" && Number.isFinite(obj.cacheMB) && obj.cacheMB > 0) {
      out.cacheMB = obj.cacheMB;
    }
    return out;
  } catch (err) {
    logWarn("tui config parse failed", {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
