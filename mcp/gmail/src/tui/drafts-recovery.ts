// Local `.eml` draft recovery.
//
// useEditor.ts persists every compose to a stable `<kind>-<timestamp>[-n].eml`
// file under `<configDir>/drafts/` and NEVER deletes it — App.tsx only removes
// a draft after a verified successful send. That means an aborted or crashed
// compose leaves its `.eml` behind. This module reads those files back so the
// TUI can offer "resume where you left off".
//
// Pure fs + compose-parser: no Ink, no Gmail, no React. The `X-Gmail-MCP-*`
// breadcrumbs written by buildComposeTemplate let a recovered reply re-thread
// onto its original message.

import fs from "node:fs/promises";
import path from "node:path";
import { getDraftsDir } from "../core/config-paths.js";
import { parseCompose } from "./compose-parser.js";

export interface LocalDraft {
  /** Absolute path to the `.eml` file on disk. */
  path: string;
  /** Basename, e.g. `reply-all-2026-07-27-101500.eml`. */
  filename: string;
  /** Compose kind — the `X-Gmail-MCP-Kind` header if present, else the filename prefix. */
  kind: string;
  /** Sortable timestamp string parsed from the filename (`YYYY-MM-DD-HHMMSS`), else "". */
  timestamp: string;
  /** File mtime in ms — the sort key (most recent first). */
  mtimeMs: number;
  subject: string;
  to: string[];
  /** First ~120 chars of the body, whitespace-collapsed, for the picker row. */
  snippet: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
}

// `<kind>-<YYYY-MM-DD-HHMMSS>[-n].eml`. Kind is non-greedy so `reply-all` and
// `draft-edit` (which contain hyphens) split correctly from the timestamp.
const FILENAME_RE = /^(?<kind>[a-z-]+?)-(?<ts>\d{4}-\d{2}-\d{2}-\d{6})(?:-\d+)?\.eml$/i;

function parseFilename(filename: string): { kind: string; timestamp: string } {
  const m = filename.match(FILENAME_RE);
  if (m?.groups?.kind && m.groups.ts) return { kind: m.groups.kind, timestamp: m.groups.ts };
  const base = filename.replace(/\.eml$/i, "");
  return { kind: base.split("-")[0] || "draft", timestamp: "" };
}

function snippetOf(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

/**
 * List locally-persisted compose drafts, most-recently-modified first. Returns
 * an empty array when the drafts directory doesn't exist yet. Unreadable or
 * vanished files are skipped rather than throwing, so a half-written file never
 * breaks the picker.
 */
export async function listLocalDrafts(env: NodeJS.ProcessEnv = process.env): Promise<LocalDraft[]> {
  const dir = getDraftsDir(env);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const drafts: LocalDraft[] = [];
  for (const filename of entries) {
    if (!filename.toLowerCase().endsWith(".eml")) continue;
    const full = path.join(dir, filename);
    let raw: string;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      mtimeMs = stat.mtimeMs;
      raw = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const parsed = parseCompose(raw);
    const fromName = parseFilename(filename);
    const draft: LocalDraft = {
      path: full,
      filename,
      kind: parsed.kind ?? fromName.kind,
      timestamp: fromName.timestamp,
      mtimeMs,
      subject: parsed.subject,
      to: parsed.to,
      snippet: snippetOf(parsed.body),
    };
    if (parsed.sourceMessageId) draft.sourceMessageId = parsed.sourceMessageId;
    if (parsed.sourceThreadId) draft.sourceThreadId = parsed.sourceThreadId;
    drafts.push(draft);
  }
  drafts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return drafts;
}

/** Read a single local draft's raw `.eml` content (for resuming into the editor). */
export async function readLocalDraft(draftPath: string): Promise<string> {
  return fs.readFile(draftPath, "utf8");
}

/** Discard (delete) a local draft file. Best-effort; never throws. */
export async function discardLocalDraft(draftPath: string): Promise<void> {
  await fs.rm(draftPath, { force: true }).catch(() => {
    /* best-effort; never throws */
  });
}
