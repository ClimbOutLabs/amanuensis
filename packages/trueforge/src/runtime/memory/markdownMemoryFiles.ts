/**
 * Filesystem layout helpers for the markdown memory backend, shared by the client
 * and the embedding subsystem.
 *
 * Canonical owner of: namespace sanitizing, daily-log entry splitting, the on-disk
 * entry text format, and namespace scans. `MarkdownMemoryClient` and the embedding
 * backfill both read through here so the text the indexer embeds is byte-identical
 * to the text recall returns — a mismatch would re-embed every entry on each pass.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureWritableDataDir,
  isDataDirConfigurationError,
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
} from '../../utils/dataDir';
import type { RetainItem } from './hindsightClient';
import { MEMORY_ORIGIN_METADATA_KEY, TOOL_INGESTED_ORIGIN, USER_STATED_ORIGIN } from './memoryOrigin';

/** Longest namespace directory name; longer names are cut. */
const NAMESPACE_MAX_LENGTH = 64;

/** Filesystem-safe namespace; path traversal collapses to underscores. */
export function sanitizeNamespace(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, NAMESPACE_MAX_LENGTH);
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

/** Entries of one daily log, with the stable ids recall, the embedding index and the vault share. */
export function dailyLogEntries(input: { safeNamespace: string; file: string; content: string }): ScannedMemoryEntry[] {
  const entries: ScannedMemoryEntry[] = [];
  const parts = splitEntries(input.content);
  for (let index = 0; index < parts.length; index++) {
    const text = parts[index];
    if (text !== undefined) {
      entries.push({ id: `md:${input.safeNamespace}:${input.file}#${String(index)}`, file: input.file, index, text });
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
  const text = context !== undefined && context.length > 0 ? `${item.content}\n\n> ${context}` : item.content;
  const entry = `## ${item.timestamp}\n\n${escapeEntryStructure(text)}`;
  const origin = item.metadata?.[MEMORY_ORIGIN_METADATA_KEY];
  return origin === undefined || origin === USER_STATED_ORIGIN ? entry : `${entry}\n\n${READ_CONTENT_SOURCE_LINE}`;
}

/** Closing line marking an entry written after Aman read an email, document, or web page. */
const READ_CONTENT_SOURCE_LINE = '> Source: read content';

/**
 * Backslash-escapes body lines `splitEntries` or `entryMetadata` would read as structure (an
 * entry heading or the source marker), so retained text can neither split its entry, which drops
 * the marker from the earlier fragments, nor forge the marker. The escape stays readable Markdown.
 */
function escapeEntryStructure(text: string): string {
  return text
    .split('\n')
    .map(line => (line.startsWith('## ') || line.trimEnd() === READ_CONTENT_SOURCE_LINE ? `\\${line}` : line))
    .join('\n');
}

/** Metadata recall hands back for an entry, read from the marker line `formatRetainEntry` wrote. */
export function entryMetadata(text: string): Record<string, string> | undefined {
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  return lastLine === READ_CONTENT_SOURCE_LINE ? { [MEMORY_ORIGIN_METADATA_KEY]: TOOL_INGESTED_ORIGIN } : undefined;
}

/** Curated long-term memory file inside a namespace directory. */
export const CURATED_MEMORY_FILE = 'MEMORY.md';

/** Daily logs live in the namespace's `memory/` directory, one file per day. */
export const DAILY_LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

/** The day file named by a vault-relative path such as `memory/2026-10-01.md`, or undefined for any other path. */
export function dailyLogFileAt(relativePath: string): string | undefined {
  const prefix = 'memory/';
  const name = relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : '';
  return DAILY_LOG_FILE_PATTERN.test(name) ? name : undefined;
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
    const raw = await readFile(path.join(dir, CURATED_MEMORY_FILE), 'utf8');
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
      .filter(name => DAILY_LOG_FILE_PATTERN.test(name))
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
    entries.push(...dailyLogEntries({ safeNamespace, file, content }));
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
export const VAULT_TOMBSTONES_FILE = '.vault-tombstones.md';

/** Marker line inside a marker block: `> vault-entry <entryId> <updated|deleted>`. */
const VAULT_MARKER_PREFIX = '> vault-entry ';

/**
 * The replacement text for an update rides on the marker line as a JSON payload
 * (`{"text":"..."}`). JSON encoding keeps the marker one line long, so arbitrary
 * Markdown in the text (fences, headings) can never corrupt parsing.
 */

/** Sharing config file inside the tenant's own namespace directory. */
const VAULT_SHARING_FILE = '.vault-sharing.json';

/** One vault edit/delete marker. `text` is the replacement text for updates. */
export interface VaultTombstone {
  entryId: string;
  action: 'updated' | 'deleted';
  text: string | undefined;
  /** ISO-8601 instant the marker was recorded. */
  timestamp: string;
}

/** Suffix `_<8 hex>` that marks a persona vault name made unique by a hash. */
const VAULT_HASH_SUFFIX = /_[0-9a-f]{8}$/;

/**
 * Directory segment of a persona vault. A name that survives sanitizing and fits keeps
 * its plain segment. Any other name (unsafe characters, truncation, or a plain name that
 * already looks like a hashed one) gets a short hash of the original wire name, so two
 * distinct names never share a directory and therefore never share facts. The hash is
 * 32 bits, ample for the handful of personas one tenant has. A tenant id that leaves no
 * room for the hash inside the directory length cap cannot be disambiguated.
 */
function personaVaultSegment(options: { tenantPrefix: string; wire: string }): string {
  const { tenantPrefix, wire } = options;
  const name = wire.slice(VAULT_PERSONA_PREFIX.length);
  const segment = sanitizeNamespace(wire);
  if (
    sanitizeNamespace(name) === name &&
    !VAULT_HASH_SUFFIX.test(name) &&
    tenantPrefix.length + segment.length <= NAMESPACE_MAX_LENGTH
  ) {
    return segment;
  }
  const hash = createHash('sha256').update(wire, 'utf8').digest('hex').slice(0, 8);
  const room = Math.max(NAMESPACE_MAX_LENGTH - tenantPrefix.length - hash.length - 1, 0);
  return `${segment.slice(0, room)}_${hash}`;
}

/**
 * Tenant-scoped filesystem namespace for a vault wire namespace. Persona vaults get
 * collision-free segments; topic vaults keep their sanitized names so existing data stays put.
 */
export function vaultFilesystemNamespace(tenantNamespace: string, wireNamespace: string | undefined): string {
  const wire = (wireNamespace ?? '').trim();
  if (wire === '' || wire === VAULT_DEFAULT_NAMESPACE) {
    return tenantNamespace;
  }
  const tenantPrefix = `${tenantNamespace}__`;
  if (personaForVaultNamespace(wire) === null) {
    return `${tenantPrefix}${sanitizeNamespace(wire)}`;
  }
  return `${tenantPrefix}${personaVaultSegment({ tenantPrefix, wire })}`;
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

/** Wire namespace of a persona's vault (`persona:<name>`). */
export function personaVaultNamespace(personaName: string): string {
  return `${VAULT_PERSONA_PREFIX}${personaName}`;
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
  const name = filesystemNamespace.slice(prefix.length).replace(VAULT_HASH_SUFFIX, '');
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
export async function readVaultTombstones(options: { baseDir: string; namespace: string }): Promise<VaultTombstone[]> {
  let content: string;
  try {
    content = await readFile(vaultTombstonesFileFor(options.baseDir, options.namespace), 'utf8');
  } catch {
    return [];
  }
  return parseVaultTombstones(content);
}

/** Parses the text of a `.vault-tombstones.md` file, oldest marker first; malformed blocks are skipped. */
export function parseVaultTombstones(content: string): VaultTombstone[] {
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
    await writeFile(
      vaultTombstonesFileFor(options.baseDir, options.namespace),
      `${formatVaultTombstone(options.tombstone)}\n\n`,
      {
        flag: 'a',
        encoding: 'utf8',
      },
    );
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
export async function scanVaultEntries(options: { baseDir: string; namespace: string }): Promise<VaultScannedEntry[]> {
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

/** Per-persona sharing config: which vault namespaces each persona may read. */
export interface VaultSharing {
  version: 1;
  shares: Record<string, string[]>;
}

const EMPTY_VAULT_SHARING: VaultSharing = { version: 1, shares: {} };

function vaultSharingFileFor(baseDir: string, tenantNamespace: string): string {
  return path.join(namespaceDirFor(baseDir, tenantNamespace), VAULT_SHARING_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVaultSharing(value: unknown): value is VaultSharing {
  if (!isRecord(value)) {
    return false;
  }
  if (value['version'] !== 1 || !isRecord(value['shares'])) {
    return false;
  }
  for (const [persona, namespaces] of Object.entries(value['shares'])) {
    if (typeof persona !== 'string' || !Array.isArray(namespaces)) {
      return false;
    }
    for (const namespace of namespaces) {
      if (typeof namespace !== 'string') {
        return false;
      }
    }
  }
  return true;
}

/** Reads the tenant's vault sharing config; a missing or corrupt file reads as empty. */
export async function readVaultSharing(options: { baseDir: string; tenantNamespace: string }): Promise<VaultSharing> {
  try {
    const raw = await readFile(vaultSharingFileFor(options.baseDir, options.tenantNamespace), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isVaultSharing(parsed)) {
      return parsed;
    }
    return EMPTY_VAULT_SHARING;
  } catch {
    return EMPTY_VAULT_SHARING;
  }
}

/** Replaces the tenant's vault sharing config. */
export async function writeVaultSharing(options: {
  baseDir: string;
  tenantNamespace: string;
  sharing: VaultSharing;
}): Promise<void> {
  try {
    const dir = namespaceDirFor(options.baseDir, options.tenantNamespace);
    await ensureWritableDataDir({ dir, envVar: 'MEMORY_MARKDOWN_DIR' });
    await writeFile(
      vaultSharingFileFor(options.baseDir, options.tenantNamespace),
      JSON.stringify(options.sharing),
      'utf8',
    );
  } catch (error) {
    if (isDataDirConfigurationError(error)) {
      throw new Error(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/** The vault a memory client belongs to. No scope means the shared vault only. */
export interface VaultScope {
  /** Display name of the active persona; selects its `persona:<name>` vault. */
  personaName: string;
  /** Persona id; sharing grants may be keyed by either the id or the name. */
  personaId: string;
}

/** The one vault a scope writes into: its persona vault, else the shared vault. */
export function vaultWriteNamespace(options: { tenantNamespace: string; scope: VaultScope | undefined }): string {
  if (options.scope === undefined) {
    return options.tenantNamespace;
  }
  return vaultFilesystemNamespace(options.tenantNamespace, personaVaultNamespace(options.scope.personaName));
}

/**
 * Every vault a scope may recall from, in priority order: its own persona vault,
 * the shared vault, then vaults the sharing config grants to it. Without a scope
 * only the shared vault is readable. Grants are read-only and never add a write target.
 */
export async function vaultReadNamespaces(options: {
  baseDir: string;
  tenantNamespace: string;
  scope: VaultScope | undefined;
}): Promise<string[]> {
  const { baseDir, tenantNamespace, scope } = options;
  const namespaces = [vaultWriteNamespace({ tenantNamespace, scope }), tenantNamespace];
  if (scope !== undefined) {
    const { shares } = await readVaultSharing({ baseDir, tenantNamespace });
    for (const key of [scope.personaName, scope.personaId]) {
      // Own-property check: a persona named like an Object.prototype member must not match.
      const granted = Object.hasOwn(shares, key) ? shares[key] : undefined;
      for (const wireNamespace of granted ?? []) {
        namespaces.push(vaultFilesystemNamespace(tenantNamespace, wireNamespace));
      }
    }
  }
  const seen = new Set<string>();
  return namespaces.filter(namespace => {
    const directory = sanitizeNamespace(namespace);
    if (seen.has(directory)) {
      return false;
    }
    seen.add(directory);
    return true;
  });
}
