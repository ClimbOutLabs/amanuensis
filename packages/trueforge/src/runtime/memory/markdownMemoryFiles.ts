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
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import {
  ensureWritableDataDir,
  isDataDirConfigurationError,
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
} from '../../utils/dataDir';
import type { RetainItem } from './hindsightClient';
import {
  ASSISTANT_RESPONSE_SOURCE,
  formatNoteMarker,
  isMemoryNoteSource,
  NOTE_DATE_METADATA_KEY,
  NOTE_SOURCE_METADATA_KEY,
  noteProvenanceFromMetadata,
  parseNoteMarker,
  withoutNoteTrailer,
} from './memoryNotes';
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

/**
 * Older versions wrote a `Turn summary: ` prefix right after each entry heading and a closing
 * `> Chat title: ...` line, which sits last in its entry (before a source line, if any). Neither is
 * a fact, so both are dropped. A title-looking line inside an entry's text is left alone. Only
 * whole lines are touched, so the entry count, and with it every entry id, stays the same, and
 * running it again changes nothing.
 */
export function upgradeLegacyEntries(content: string): string {
  const prefix = /(^|\n)(## [^\n]*\n\n)(?:Turn summary: ?)+/g;
  const trailingTitle = /\n\n> Chat title: [^\n]*(?=(?:\n\n> Source: read content)?(?:\n*$|\n+## ))/g;
  let upgraded = content;
  for (let previous = ''; previous !== upgraded;) {
    previous = upgraded;
    upgraded = upgraded.replace(prefix, '$1$2').replace(trailingTitle, '');
  }
  return upgraded;
}

/** Entries of one daily log, with the stable ids recall, the embedding index and the vault share. */
export function dailyLogEntries(input: { safeNamespace: string; file: string; content: string }): ScannedMemoryEntry[] {
  const entries: ScannedMemoryEntry[] = [];
  const parts = splitEntries(upgradeLegacyEntries(input.content));
  for (let index = 0; index < parts.length; index++) {
    const text = parts[index];
    if (text !== undefined) {
      entries.push({ id: `md:${input.safeNamespace}:${input.file}#${String(index)}`, file: input.file, index, text });
    }
  }
  return entries;
}

/** Metadata key naming the chat an entry came from; stored as a hidden trailer line, never in the fact text. */
export const SESSION_ID_METADATA_KEY = 'session_id';

/**
 * Whether a recalled note was written in the given chat. The chat's full history is already in the
 * conversation, so an older copy can only mislead. A note with no recorded chat (written before notes
 * recorded one) is judged to be from another chat: a chat title is not unique, so it is never used to guess.
 */
export function isFromSession({
  metadata,
  sessionId,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  sessionId: string | undefined;
}): boolean {
  return sessionId !== undefined && sessionId !== '' && metadata?.[SESSION_ID_METADATA_KEY] === sessionId;
}

/** What a chat id may hold so it can ride in a hidden closing line; the one owner of that rule. */
const SESSION_ID_CHARACTERS = '[A-Za-z0-9_-]{1,128}';

/** Hidden (Markdown comment) trailer carrying the chat id; it renders as nothing and holds no fact. */
const SESSION_MARKER_PATTERN = new RegExp(`^<!-- session_id: (${SESSION_ID_CHARACTERS}) -->$`);

/**
 * Metadata key naming the document an entry replaces on every later write under the same id; stored
 * as a hidden trailer, like the chat id. Set only for items that ask to replace (see below).
 */
export const DOCUMENT_ID_METADATA_KEY = 'document_id';

/**
 * Metadata key (value `true`) asking a store that keeps entries as appended text to replace the
 * item's earlier entries with the same document id, as Hindsight does by itself.
 */
export const REPLACE_DOCUMENT_METADATA_KEY = 'replace_document';

/** Hidden trailer carrying the document id. Ids are the host's own (hashes and prefixes), never free text. */
const DOCUMENT_MARKER_PATTERN = /^<!-- document_id: ([A-Za-z0-9_.-]{1,128}) -->$/;

/** Closing line marking an entry written after the assistant read an email, document, or web page. */
const READ_CONTENT_SOURCE_LINE = '> Source: read content';

/** What the Memories page shows in place of that line for a note about the assistant's own reply. */
const ASSISTANT_REPLY_SOURCE_LINE = '> Source: assistant reply';

/**
 * The exact on-disk text of one retained entry, trimmed. `retain()` appends one
 * `${formatRetainEntry(item)}\n` per item with blank-line separators, so this must
 * stay byte-identical to what `splitEntries` yields when the file is read back —
 * the embedding indexer hashes this text, and a mismatch would re-embed entries
 * on every pass.
 *
 * Layout: heading, the text with its optional `> context` line, then optional trailer lines (the
 * hidden chat id, the hidden document id, then the read-content marker).
 */
export function formatRetainEntry(item: RetainItem): string {
  const context = item.context?.trim();
  // Only the metadata says what is a note. Its marker, when the content also ends with it, is written once,
  // as a trailer; any other marker-looking last line is body text and is escaped like every other.
  const note = noteProvenanceFromMetadata(item.metadata);
  const marker = note === undefined ? undefined : formatNoteMarker(note);
  const content =
    marker !== undefined && item.content.trimEnd().endsWith(`\n${marker}`)
      ? withoutNoteTrailer(item.content)
      : item.content;
  const text = context !== undefined && context.length > 0 ? `${content}\n\n> ${context}` : content;
  const parts = [`## ${item.timestamp}`, escapeEntryStructure(text)];
  const sessionId = item.metadata?.[SESSION_ID_METADATA_KEY];
  if (sessionId !== undefined) {
    const marker = `<!-- session_id: ${sessionId} -->`;
    if (SESSION_MARKER_PATTERN.test(marker)) {
      parts.push(marker);
    }
  }
  if (item.metadata?.[REPLACE_DOCUMENT_METADATA_KEY] === 'true') {
    const marker = `<!-- document_id: ${item.document_id} -->`;
    if (DOCUMENT_MARKER_PATTERN.test(marker)) {
      parts.push(marker);
    }
  }
  if (marker !== undefined && parseNoteMarker(marker) !== undefined) {
    parts.push(marker);
  }
  const origin = item.metadata?.[MEMORY_ORIGIN_METADATA_KEY];
  if (origin !== undefined && origin !== USER_STATED_ORIGIN) {
    parts.push(READ_CONTENT_SOURCE_LINE);
  }
  return parts.join('\n\n');
}

/**
 * Backslash-escapes body lines `splitEntries` or `entryMetadata` would read as structure (an
 * entry heading or a trailer line), so retained text can neither split its entry, which drops
 * the trailers from the earlier fragments, nor forge a trailer. The escape stays readable Markdown.
 */
function escapeEntryStructure(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const trimmed = line.trimEnd();
      return line.startsWith('## ') ||
        trimmed === READ_CONTENT_SOURCE_LINE ||
        trimmed === ASSISTANT_REPLY_SOURCE_LINE ||
        SESSION_MARKER_PATTERN.test(trimmed) ||
        DOCUMENT_MARKER_PATTERN.test(trimmed) ||
        parseNoteMarker(trimmed) !== undefined
        ? `\\${line}`
        : line;
    })
    .join('\n');
}

/** An entry's text split into its body and the metadata its trailer lines carry. */
function splitEntryTrailers(text: string): { body: string; metadata: Record<string, string> } {
  const lines = text.split('\n');
  const metadata: Record<string, string> = {};
  while (lines.length > 0) {
    const line = (lines[lines.length - 1] ?? '').trimEnd();
    const sessionId = SESSION_MARKER_PATTERN.exec(line)?.[1];
    const documentId = DOCUMENT_MARKER_PATTERN.exec(line)?.[1];
    const note = parseNoteMarker(line);
    if (line === '') {
      lines.pop();
    } else if (line === READ_CONTENT_SOURCE_LINE || line === ASSISTANT_REPLY_SOURCE_LINE) {
      metadata[MEMORY_ORIGIN_METADATA_KEY] = TOOL_INGESTED_ORIGIN;
      lines.pop();
    } else if (sessionId !== undefined) {
      // Every closing marker is dropped; the one nearest the end is the one that counts.
      metadata[SESSION_ID_METADATA_KEY] ??= sessionId;
      lines.pop();
    } else if (documentId !== undefined) {
      metadata[DOCUMENT_ID_METADATA_KEY] ??= documentId;
      lines.pop();
    } else if (note !== undefined) {
      metadata[NOTE_SOURCE_METADATA_KEY] ??= note.source;
      metadata[NOTE_DATE_METADATA_KEY] ??= note.date;
      lines.pop();
    } else {
      break;
    }
  }
  return { body: lines.join('\n').trim(), metadata };
}

/** Metadata recall hands back for an entry, read from the trailer lines `formatRetainEntry` wrote. */
export function entryMetadata(text: string): Record<string, string> | undefined {
  const { metadata } = splitEntryTrailers(text);
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

/**
 * True for an entry stored as a copy of a replaced document before entries recorded a document id.
 * Such a copy carries no trailer at all (a document mirror never recorded a chat or a source), and
 * its body closes with the document's own `> context` line. An entry with any trailer is a chat note
 * or an imported note that merely quotes the line, never a copy.
 */
export function isLegacyDocumentCopy({ text, context }: { text: string; context: string }): boolean {
  const { body, metadata } = splitEntryTrailers(text);
  if (Object.keys(metadata).length > 0) {
    return false;
  }
  const lines = body.split('\n');
  const closing = (lines.pop() ?? '').trim();
  return closing === `> ${context}` && lines.some(line => line.trim() !== '' && !line.startsWith('## '));
}

/** The entry text the Memories page shows and edits: the hidden chat id, document id and note lines are dropped. */
export function withoutHiddenMarkers(text: string): string {
  const { body, metadata } = splitEntryTrailers(text);
  if (
    metadata[SESSION_ID_METADATA_KEY] === undefined &&
    metadata[DOCUMENT_ID_METADATA_KEY] === undefined &&
    metadata[NOTE_SOURCE_METADATA_KEY] === undefined
  ) {
    return text;
  }
  if (metadata[MEMORY_ORIGIN_METADATA_KEY] === undefined) {
    return body;
  }
  const sourceLine =
    metadata[NOTE_SOURCE_METADATA_KEY] === ASSISTANT_RESPONSE_SOURCE
      ? ASSISTANT_REPLY_SOURCE_LINE
      : READ_CONTENT_SOURCE_LINE;
  return `${body}\n\n${sourceLine}`;
}

/** The instant in an entry's `## ` heading, when the heading is a readable timestamp. */
function headingInstant(text: string): string | undefined {
  const heading = text.startsWith('## ') ? (text.split('\n', 1)[0] ?? '').slice(3).trim() : '';
  return /^\d{4}-\d{2}-\d{2}T/.test(heading) && !Number.isNaN(new Date(heading).getTime())
    ? new Date(heading).toISOString()
    : undefined;
}

/**
 * An edited entry's text with the hidden chat id and document id of the original put back (the Memories
 * page sends the text without them), so editing a note never makes it forget where it came from.
 */
export function withOriginalHiddenMarkers({ original, edited }: { original: string; edited: string }): string {
  const kept = splitEntryTrailers(original).metadata;
  const { body, metadata } = splitEntryTrailers(edited);
  const trailers: string[] = [];
  const sessionId = kept[SESSION_ID_METADATA_KEY];
  if (sessionId !== undefined && metadata[SESSION_ID_METADATA_KEY] === undefined) {
    trailers.push(`<!-- session_id: ${sessionId} -->`);
  }
  const documentId = kept[DOCUMENT_ID_METADATA_KEY];
  if (documentId !== undefined && metadata[DOCUMENT_ID_METADATA_KEY] === undefined) {
    trailers.push(`<!-- document_id: ${documentId} -->`);
  }
  const noteSource = kept[NOTE_SOURCE_METADATA_KEY];
  const noteDate = kept[NOTE_DATE_METADATA_KEY];
  if (
    noteSource !== undefined &&
    isMemoryNoteSource(noteSource) &&
    noteDate !== undefined &&
    metadata[NOTE_SOURCE_METADATA_KEY] === undefined
  ) {
    trailers.push(formatNoteMarker({ source: noteSource, date: noteDate }));
  }
  if (trailers.length === 0) {
    return edited;
  }
  if (metadata[MEMORY_ORIGIN_METADATA_KEY] !== undefined) {
    trailers.push(READ_CONTENT_SOURCE_LINE);
  }
  return [body, ...trailers].join('\n\n');
}

/** When an entry was written: its `## ` heading instant, else the day in its daily file name. */
export function entryOccurredAt(entry: { id: string; text: string }): string | undefined {
  return headingInstant(entry.text) ?? /(\d{4}-\d{2}-\d{2})\.md#\d+$/.exec(entry.id)?.[1];
}

/** An entry's body with case and spacing flattened and every trailer dropped, so two copies of one note compare equal. */
export function normalizedEntryBody(text: string): string {
  return entryRecallText(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * What recall shows the model for an entry: the text alone. The timestamp heading, the hidden chat id
 * and the read-content marker are left out because recall reports them as the item's date and origin.
 */
export function entryRecallText(text: string): string {
  const { body } = splitEntryTrailers(text);
  return headingInstant(body) === undefined ? body : body.slice(body.indexOf('\n') + 1 || body.length).trim();
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
      resolved.push({ ...entry, text: withOriginalHiddenMarkers({ original: entry.text, edited: tombstone.text }) });
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
      text: withoutHiddenMarkers(entry.text),
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

/**
 * Marker file inside a namespace directory: present while the vault's newest turn
 * summary is still owed. It lives beside the sharing config, never inside `memory/`,
 * so the vault scans never read it as a memory entry.
 */
export const SUMMARY_PENDING_FILE = '.summary-pending.json';

/** What the summary-pending marker records: when the attempt failed, and the log's reason code for why. */
export interface SummaryPendingMark {
  failed_at: string;
  reason: string;
}

function summaryPendingFileFor(baseDir: string, namespace: string): string {
  return path.join(namespaceDirFor(baseDir, namespace), SUMMARY_PENDING_FILE);
}

function isSummaryPendingMark(value: unknown): value is SummaryPendingMark {
  return isRecord(value) && typeof value['failed_at'] === 'string' && typeof value['reason'] === 'string';
}

/** Records that this vault's newest turn summary failed and is still owed. */
export async function markSummaryFailed(options: {
  baseDir: string;
  namespace: string;
  mark: SummaryPendingMark;
}): Promise<void> {
  try {
    const dir = namespaceDirFor(options.baseDir, options.namespace);
    await ensureWritableDataDir({ dir, envVar: 'MEMORY_MARKDOWN_DIR' });
    await writeFile(summaryPendingFileFor(options.baseDir, options.namespace), JSON.stringify(options.mark), 'utf8');
  } catch (error) {
    if (isDataDirConfigurationError(error)) {
      throw new Error(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/** Removes the summary-pending marker: a later summary for this vault succeeded. */
export async function clearSummaryPending(options: { baseDir: string; namespace: string }): Promise<void> {
  await rm(summaryPendingFileFor(options.baseDir, options.namespace), { force: true });
}

/** Reads the summary-pending marker; a missing or unreadable marker reads as no summary owed. */
export async function readSummaryPending(options: {
  baseDir: string;
  namespace: string;
}): Promise<SummaryPendingMark | undefined> {
  try {
    const raw = await readFile(summaryPendingFileFor(options.baseDir, options.namespace), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isSummaryPendingMark(parsed) ? parsed : undefined;
  } catch {
    return undefined;
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
 * the shared vault, then vaults the sharing config grants to it. Without a scope the
 * main assistant's grants apply. Grants are read-only and never add a write target.
 */
export async function vaultReadNamespaces(options: {
  baseDir: string;
  tenantNamespace: string;
  scope: VaultScope | undefined;
}): Promise<string[]> {
  const { baseDir, tenantNamespace, scope } = options;
  const namespaces = [vaultWriteNamespace({ tenantNamespace, scope }), tenantNamespace];
  const { shares } = await readVaultSharing({ baseDir, tenantNamespace });
  // With no agent answering, the main assistant's grants apply.
  const keys = scope === undefined ? [MAIN_ASSISTANT_SHARING_KEY] : [scope.personaName, scope.personaId];
  for (const key of keys) {
    // Own-property check: a persona named like an Object.prototype member must not match.
    const granted = Object.hasOwn(shares, key) ? shares[key] : undefined;
    for (const wireNamespace of granted ?? []) {
      namespaces.push(vaultFilesystemNamespace(tenantNamespace, wireNamespace));
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
