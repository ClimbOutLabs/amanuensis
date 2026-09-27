/**
 * Filesystem layout helpers for the markdown memory backend, shared by the client
 * and the embedding subsystem.
 *
 * Canonical owner of: namespace sanitizing, daily-log entry splitting, the on-disk
 * entry text format, and namespace scans. `MarkdownMemoryClient` and the embedding
 * backfill both read through here so the text the indexer embeds is byte-identical
 * to the text recall returns — a mismatch would re-embed every entry on each pass.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
  ensureWritableDataDir,
  isDataDirConfigurationError,
} from '../../utils/dataDir';
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
 * to index the whole history. `resolveTombstones` applies the memory vault's
 * edit/delete markers so listings, recall, and the embedding index all see the
 * effective entries; it defaults to false so raw scans stay byte-identical.
 */
export async function scanNamespaceEntries(options: {
  baseDir: string;
  namespace: string;
  maxDailyFiles: number;
  resolveTombstones?: boolean;
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
  if (options.resolveTombstones === true) {
    const tombstones = await readVaultTombstones({ baseDir: options.baseDir, namespace: options.namespace });
    return { curated, entries: applyVaultTombstones(entries, tombstones) };
  }
  return { curated, entries };
}

/**
 * Memory vault: per-tenant vault namespaces and edit/delete markers.
 *
 * Vault namespaces are tenant-scoped by construction: the shared vault is the
 * tenant's own memory namespace, and every other wire namespace maps under it,
 * so one tenant's vault can never address another tenant's files. `persona:<name>`
 * namespaces are persona vaults; anything else is a topic vault.
 *
 * Edits and deletes never rewrite the daily logs. They append a marker block to
 * `.vault-tombstones.md` in the namespace directory; the marker file itself is
 * append-only, so the whole history (memories and vault actions) stays intact and
 * entry indices never shift. Later markers win per entry id.
 */

/** Wire namespace of the shared vault; also used when the query param is omitted. */
export const VAULT_DEFAULT_NAMESPACE = 'default';

/** Prefix of a persona vault's wire namespace (`persona:<name>`). */
const VAULT_PERSONA_PREFIX = 'persona:';

/** Append-only vault marker file inside a namespace directory. */
const VAULT_TOMBSTONES_FILE = '.vault-tombstones.md';

/** Marker line inside a marker block: `> vault-entry <entryId> <updated|deleted>`. */
const VAULT_MARKER_PREFIX = '> vault-entry ';

/**
 * The replacement text for an update rides on the marker line as a JSON payload
 * (`{"text":"..."}`). JSON encoding keeps the marker one line long, so arbitrary
 * Markdown in the text (fences, headings) can never corrupt parsing.
 */

/** One vault edit/delete marker. `text` is the replacement text for updates. */
export interface VaultTombstone {
  entryId: string;
  action: 'updated' | 'deleted';
  text: string | undefined;
  /** ISO-8601 instant the marker was recorded. */
  timestamp: string;
}

/** Tenant-scoped filesystem namespace for a vault wire namespace. */
export function vaultFilesystemNamespace(
  tenantNamespace: string,
  wireNamespace: string | undefined,
): string {
  const wire = (wireNamespace ?? '').trim();
  if (wire === '' || wire === VAULT_DEFAULT_NAMESPACE) {
    return tenantNamespace;
  }
  return `${tenantNamespace}__${sanitizeNamespace(wire)}`;
}

/** Owning persona for `persona:<name>` wire namespaces, else null. */
export function personaForVaultNamespace(wireNamespace: string | undefined): string | null {
  const wire = (wireNamespace ?? '').trim();
  if (!wire.startsWith(VAULT_PERSONA_PREFIX)) {
    return null;
  }
  const name = wire.slice(VAULT_PERSONA_PREFIX.length).trim();
  return name === '' ? null : name;
}

/** Owning persona derived from a filesystem namespace, else null. Best effort: sanitized. */
export function personaForVaultFilesystemNamespace(
  tenantNamespace: string,
  filesystemNamespace: string,
): string | null {
  const prefix = `${tenantNamespace}__${sanitizeNamespace(VAULT_PERSONA_PREFIX)}`;
  if (!filesystemNamespace.startsWith(prefix)) {
    return null;
  }
  const name = filesystemNamespace.slice(prefix.length);
  return name === '' ? null : name;
}

function vaultTombstonesFileFor(baseDir: string, namespace: string): string {
  return path.join(namespaceDirFor(baseDir, namespace), VAULT_TOMBSTONES_FILE);
}

function isVaultTombstonePayload(value: unknown): value is { text: string } {
  return isRecord(value) && typeof value['text'] === 'string';
}

function parseVaultTombstoneBlock(block: { heading: string; markerLine: string }): VaultTombstone | undefined {
  const timestamp = new Date(block.heading.slice(3).trim());
  if (Number.isNaN(timestamp.getTime())) {
    return undefined;
  }
  const rest = block.markerLine.slice(VAULT_MARKER_PREFIX.length).trim().split(/\s+/);
  const entryId = rest[0];
  const action = rest[1];
  if (entryId === undefined || entryId === '' || (action !== 'updated' && action !== 'deleted')) {
    return undefined;
  }
  let text: string | undefined;
  if (action === 'updated') {
    const payload = rest.slice(2).join(' ');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return undefined;
    }
    if (!isVaultTombstonePayload(parsed)) {
      return undefined;
    }
    text = parsed.text;
  }
  return {
    entryId,
    action,
    text,
    timestamp: timestamp.toISOString(),
  };
}

function formatVaultTombstone(tombstone: VaultTombstone): string {
  const payload =
    tombstone.action === 'updated' && tombstone.text !== undefined
      ? ` ${JSON.stringify({ text: tombstone.text })}`
      : '';
  return `## ${tombstone.timestamp}\n\n${VAULT_MARKER_PREFIX}${tombstone.entryId} ${tombstone.action}${payload}`;
}

/**
 * Reads a namespace's vault markers, oldest first. Missing file reads as no markers.
 * Each marker is two lines (a `## ` heading and the `> vault-entry` marker line),
 * parsed with a small line scanner so replacement text is never mistaken for structure.
 */
export async function readVaultTombstones(options: {
  baseDir: string;
  namespace: string;
}): Promise<VaultTombstone[]> {
  let content: string;
  try {
    content = await readFile(vaultTombstonesFileFor(options.baseDir, options.namespace), 'utf8');
  } catch {
    return [];
  }
  const tombstones: VaultTombstone[] = [];
  let heading: string | undefined;
  let markerLine: string | undefined;
  const flush = (): void => {
    if (heading !== undefined && markerLine !== undefined) {
      const tombstone = parseVaultTombstoneBlock({ heading, markerLine });
      if (tombstone !== undefined) {
        tombstones.push(tombstone);
      }
    }
    heading = undefined;
    markerLine = undefined;
  };
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      heading = line;
    } else if (line.startsWith(VAULT_MARKER_PREFIX)) {
      markerLine = line;
    }
  }
  flush();
  return tombstones;
}

/**
 * Appends one vault marker. The marker file is append-only; only the daily logs
 * would count as history, and they are never touched.
 */
export async function appendVaultTombstone(options: {
  baseDir: string;
  namespace: string;
  tombstone: VaultTombstone;
}): Promise<void> {
  try {
    const dir = namespaceDirFor(options.baseDir, options.namespace);
    await ensureWritableDataDir({ dir, envVar: 'MEMORY_MARKDOWN_DIR' });
    await writeFile(vaultTombstonesFileFor(options.baseDir, options.namespace), `${formatVaultTombstone(options.tombstone)}\n\n`, {
      flag: 'a',
      encoding: 'utf8',
    });
  } catch (error) {
    if (isDataDirConfigurationError(error)) {
      throw new Error(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/**
 * Applies vault markers to scanned entries: deleted entries are dropped, updated
 * entries keep their id with the replacement text. Later markers win per entry id.
 */
export function applyVaultTombstones(
  entries: ScannedMemoryEntry[],
  tombstones: VaultTombstone[],
): ScannedMemoryEntry[] {
  const latest = new Map<string, VaultTombstone>();
  for (const tombstone of tombstones) {
    latest.set(tombstone.entryId, tombstone);
  }
  const resolved: ScannedMemoryEntry[] = [];
  for (const entry of entries) {
    const tombstone = latest.get(entry.id);
    if (tombstone === undefined) {
      resolved.push(entry);
    } else if (tombstone.action === 'updated' && tombstone.text !== undefined) {
      resolved.push({ ...entry, text: tombstone.text });
    }
    // Deleted entries (and updates without text) are dropped.
  }
  return resolved;
}

/** Latest marker per entry id, for timestamp lookups. */
export function latestTombstonesByEntry(tombstones: VaultTombstone[]): Map<string, VaultTombstone> {
  const latest = new Map<string, VaultTombstone>();
  for (const tombstone of tombstones) {
    latest.set(tombstone.entryId, tombstone);
  }
  return latest;
}

export interface VaultScannedEntry {
  id: string;
  text: string;
  /** ISO-8601 instant: the marker time for edited entries, else the entry's own time. */
  timestamp: string;
}

/** Entry time from its `## ` heading, falling back to the file date. */
export function vaultEntryTimestamp(entry: Pick<ScannedMemoryEntry, 'file' | 'text'>): string {
  const firstLine = entry.text.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('## ')) {
    const parsed = new Date(firstLine.slice(3).trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const day = entry.file.replace(/\.md$/, '');
  const fallback = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * Tombstone-resolved vault listing for one filesystem namespace: daily entries,
 * newest file first, with deletes dropped and edits applied with their marker time.
 */
export async function scanVaultEntries(options: {
  baseDir: string;
  namespace: string;
}): Promise<VaultScannedEntry[]> {
  const scan = await scanNamespaceEntries({
    baseDir: options.baseDir,
    namespace: options.namespace,
    maxDailyFiles: Number.POSITIVE_INFINITY,
  });
  const tombstones = await readVaultTombstones({ baseDir: options.baseDir, namespace: options.namespace });
  const latest = latestTombstonesByEntry(tombstones);
  return applyVaultTombstones(scan.entries, tombstones).map(entry => {
    const tombstone = latest.get(entry.id);
    return {
      id: entry.id,
      text: entry.text,
      timestamp: tombstone?.action === 'updated' ? tombstone.timestamp : vaultEntryTimestamp(entry),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
