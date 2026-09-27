/**
 * Filesystem layout helpers for the markdown memory backend, shared by the client
 * and the embedding subsystem.
 *
 * Canonical owner of: namespace sanitizing, daily-log entry splitting, the on-disk
 * entry text format, and namespace scans. `MarkdownMemoryClient` and the embedding
 * backfill both read through here so the text the indexer embeds is byte-identical
 * to the text recall returns — a mismatch would re-embed every entry on each pass.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RetainItem } from './hindsightClient';

/** Filesystem-safe namespace; path traversal collapses to underscores. */
export function sanitizeNamespace(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe.length > 0 ? safe : 'default';
}

/** Directory holding one namespace's `MEMORY.md`, `memory/`, and caches. */
export function namespaceDirFor(baseDir: string, namespace: string): string {
  return path.join(baseDir, sanitizeNamespace(namespace));
}

/** Splits a daily log into entries on `## ` headings; unheaded content is one entry. */
export function splitEntries(content: string): string[] {
  const parts = content.split(/\n## /);
  const entries: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) {
      continue;
    }
    const text = (i === 0 ? part : `## ${part}`).trim();
    if (text.length > 0) {
      entries.push(text);
    }
  }
  return entries;
}

/**
 * The exact on-disk text of one retained entry, trimmed. `retain()` appends one
 * `${formatRetainEntry(item)}\n` per item with blank-line separators, so this must
 * stay byte-identical to what `splitEntries` yields when the file is read back —
 * the embedding indexer hashes this text, and a mismatch would re-embed entries
 * on every pass.
 */
export function formatRetainEntry(item: RetainItem): string {
  const context = item.context?.trim();
  const body = `## ${item.timestamp}\n\n${item.content}`;
  return context !== undefined && context.length > 0 ? `${body}\n\n> ${context}` : body;
}

export interface ScannedMemoryEntry {
  /** Stable id: `md:{namespace}:{file}#{index}`; append-only logs never shift indices. */
  id: string;
  file: string;
  index: number;
  text: string;
}

export interface NamespaceScan {
  /** Curated long-term memory text, when the file exists and is non-empty. */
  curated: string | undefined;
  /** Daily-log entries, newest file first, in file order. */
  entries: ScannedMemoryEntry[];
}

/** Rough chars-per-token for budget estimates; recall truncates, never over-reads. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Reads a namespace's `MEMORY.md` plus daily logs. `maxDailyFiles` bounds the scan:
 * recall passes the recent-files window; the embedding backfill passes `Infinity`
 * to index the whole history.
 */
export async function scanNamespaceEntries(options: {
  baseDir: string;
  namespace: string;
  maxDailyFiles: number;
}): Promise<NamespaceScan> {
  const safeNamespace = sanitizeNamespace(options.namespace);
  const dir = namespaceDirFor(options.baseDir, options.namespace);

  let curated: string | undefined;
  try {
    const raw = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    const text = raw.trim();
    if (text.length > 0) {
      curated = text;
    }
  } catch {
    // Missing MEMORY.md is normal for a fresh namespace, not a failure.
  }

  const entries: ScannedMemoryEntry[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(path.join(dir, 'memory')))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .reverse()
      .slice(0, options.maxDailyFiles);
  } catch {
    // Missing daily directory is normal for a fresh namespace.
  }
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(path.join(dir, 'memory', file), 'utf8');
    } catch {
      continue;
    }
    const parts = splitEntries(content);
    for (let index = 0; index < parts.length; index++) {
      const text = parts[index];
      if (text === undefined) {
        continue;
      }
      entries.push({ id: `md:${safeNamespace}:${file}#${String(index)}`, file, index, text });
    }
  }
  return { curated, entries };
}
