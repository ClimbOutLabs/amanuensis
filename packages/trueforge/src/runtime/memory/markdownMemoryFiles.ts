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
import type { Stats } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import {
  ensureWritableDataDir,
  isDataDirConfigurationError,
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
} from '../../utils/dataDir';
import type { RetainItem } from './memoryClient';
import {
  ASSISTANT_RESPONSE_SOURCE,
  formatMarker,
  isMemoryNoteSource,
  isReplyThatReadNothing,
  NOTE_DATE_METADATA_KEY,
  NOTE_SOURCE_METADATA_KEY,
  noteProvenanceFromMetadata,
  parseMarker,
  REPLY_READ_NOTHING_METADATA_KEY,
  withoutNoteTrailer,
  type MemoryNoteSource,
} from './memoryNotes';
import {
  IMPORTED_ORIGIN,
  isPersonOrigin,
  LEARNED_PROFILE_LINE_SOURCE,
  MEMORY_ORIGIN_METADATA_KEY,
  TOOL_INGESTED_ORIGIN,
  USER_STATED_ORIGIN,
} from './memoryOrigin';

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
  const trailingTitle =
    /\n\n> Chat title: [^\n]*(?=(?:\n\n> (?:Source: read content|From you|External source: [^\n]*))?(?:\n*$|\n+## ))/g;
  let upgraded = content;
  for (let previous = ''; previous !== upgraded;) {
    previous = upgraded;
    upgraded = upgraded.replace(prefix, '$1$2').replace(trailingTitle, '');
  }
  return upgraded;
}

/** What a deleted note's entry is reduced to in its dated file: it keeps its position, so later notes keep their ids. */
export const ERASED_ENTRY = '## [erased]';

/** Entries of one daily log, with the stable ids recall, the embedding index and the vault share. Erased entries hold a position but are not returned. */
export function dailyLogEntries(input: {
  safeNamespace: string;
  file: string;
  content: string;
  /** Notes the person reviewed as their own; they are handed on closing with "From you". */
  reviewed?: ReviewedMarks;
}): ScannedMemoryEntry[] {
  const entries: ScannedMemoryEntry[] = [];
  const parts = splitEntries(upgradeLegacyEntries(input.content));
  for (let index = 0; index < parts.length; index++) {
    const text = parts[index];
    if (text !== undefined && text !== ERASED_ENTRY) {
      const entry = { id: `md:${input.safeNamespace}:${input.file}#${String(index)}`, file: input.file, index, text };
      entries.push(input.reviewed === undefined ? entry : withReviewedSource(entry, input.reviewed));
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
 * Metadata key (value `true`) asking the store to replace the item's earlier entries with the
 * same document id.
 */
export const REPLACE_DOCUMENT_METADATA_KEY = 'replace_document';

/** Hidden trailer carrying the document id. Ids are the host's own (hashes and prefixes), never free text. */
const DOCUMENT_MARKER_PATTERN = /^<!-- document_id: ([A-Za-z0-9_.-]{1,128}) -->$/;

/** Closing line of an entry that holds the person's own words. */
const FROM_YOU_SOURCE_LINE = '> From you';

/** Start of the closing line of every other entry; what follows names where it came from. */
const EXTERNAL_SOURCE_LINE_PREFIX = '> External source: ';

/** Closing lines older versions wrote on an entry that is not the person's own. They stay understood. */
const LEGACY_EXTERNAL_SOURCE_LINES: readonly string[] = [
  '> Source: read content',
  '> Source: assistant reply',
  '> Source: a message you sent',
];

/** How each kind of note names its source on the closing line. */
const NOTE_SOURCE_NAMES: Record<MemoryNoteSource, string> = {
  email: 'email',
  calendar: 'calendar',
  web: 'web page',
  attachment: 'attachment',
  other: 'tool result',
  assistant_response: 'assistant reply',
  sent_mail: 'a message you sent',
};

/** How a reply names its source when its chat had read nothing from outside up to that reply. */
const REPLY_READ_NOTHING_SOURCE_NAME = 'assistant reply, nothing read before it';

/** The closing line only the save writes on such a reply. Body text that looks like it is escaped like any source line. */
const REPLY_READ_NOTHING_SOURCE_LINE = `${EXTERNAL_SOURCE_LINE_PREFIX}${REPLY_READ_NOTHING_SOURCE_NAME}`;

/** The source named for text from a turn that read an email, a page, a document or a tool result. */
const READ_CONTENT_SOURCE_NAME = 'read content';

/** The source named for a line moved out of a full learned profile. */
const LEARNED_PROFILE_SOURCE_NAME = 'learned profile';

/** The source named for text that came in through the Memories import. */
const IMPORTED_SOURCE_NAME = 'imported file';

/** The source named for an entry that carries no source line at all. */
const NO_RECORD_SOURCE_NAME = 'no record';

/** The closing line of an older note that has no record of where it came from. */
const NO_RECORD_SOURCE_LINE = `${EXTERNAL_SOURCE_LINE_PREFIX}${NO_RECORD_SOURCE_NAME}`;

function isExternalSourceLine(line: string): boolean {
  return line.startsWith(EXTERNAL_SOURCE_LINE_PREFIX) || LEGACY_EXTERNAL_SOURCE_LINES.includes(line);
}

/** Whether a line is one that says where an entry came from. */
function isSourceLine(line: string): boolean {
  return line === FROM_YOU_SOURCE_LINE || isExternalSourceLine(line);
}

/**
 * The closing line for an entry with this metadata. Only an entry whose origin says the person said it
 * closes with "From you"; a note, any other origin and a missing origin are named as an external source.
 */
function sourceLineFor(metadata: Readonly<Record<string, string>>): string {
  const note = noteProvenanceFromMetadata(metadata);
  if (note !== undefined) {
    return isReplyThatReadNothing(metadata)
      ? REPLY_READ_NOTHING_SOURCE_LINE
      : `${EXTERNAL_SOURCE_LINE_PREFIX}${NOTE_SOURCE_NAMES[note.source]}`;
  }
  if (isPersonOrigin(metadata)) {
    return FROM_YOU_SOURCE_LINE;
  }
  if (metadata[MEMORY_ORIGIN_METADATA_KEY] === IMPORTED_ORIGIN) {
    return `${EXTERNAL_SOURCE_LINE_PREFIX}${IMPORTED_SOURCE_NAME}`;
  }
  const name =
    metadata['source'] === LEARNED_PROFILE_LINE_SOURCE ? LEARNED_PROFILE_SOURCE_NAME : READ_CONTENT_SOURCE_NAME;
  return `${EXTERNAL_SOURCE_LINE_PREFIX}${name}`;
}

/**
 * The exact on-disk text of one retained entry, trimmed. `retain()` appends one
 * `${formatRetainEntry(item)}\n` per item with blank-line separators, so this must
 * stay byte-identical to what `splitEntries` yields when the file is read back —
 * the embedding indexer hashes this text, and a mismatch would re-embed entries
 * on every pass.
 *
 * Layout: heading, the text with its optional `> context` line, then the trailer lines: the optional
 * hidden chat id, document id and note lines, and always, last, the line that says where the entry came from.
 */
export function formatRetainEntry(item: RetainItem): string {
  const context = item.context?.trim();
  // Only the metadata says what is a note. Its marker, when the content also ends with it, is written once,
  // as a trailer; any other marker-looking last line is body text and is escaped like every other.
  const note = noteProvenanceFromMetadata(item.metadata);
  const marker = note === undefined ? undefined : formatMarker({ kind: 'note', ...note });
  const content =
    marker !== undefined && item.content.trimEnd().endsWith(`\n${marker}`)
      ? withoutNoteTrailer(item.content)
      : item.content;
  const text = context !== undefined && context.length > 0 ? `${content}\n\n> ${context}` : content;
  const parts = [`## ${item.timestamp}`, escapeEntryStructure(text)];
  const sessionId = item.metadata[SESSION_ID_METADATA_KEY];
  if (sessionId !== undefined) {
    const marker = `<!-- session_id: ${sessionId} -->`;
    if (SESSION_MARKER_PATTERN.test(marker)) {
      parts.push(marker);
    }
  }
  if (item.metadata[REPLACE_DOCUMENT_METADATA_KEY] === 'true') {
    const marker = `<!-- document_id: ${item.document_id} -->`;
    if (DOCUMENT_MARKER_PATTERN.test(marker)) {
      parts.push(marker);
    }
  }
  if (marker !== undefined && parseMarker(marker)?.kind === 'note') {
    parts.push(marker);
  }
  parts.push(sourceLineFor(item.metadata));
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
        isSourceLine(trimmed) ||
        SESSION_MARKER_PATTERN.test(trimmed) ||
        DOCUMENT_MARKER_PATTERN.test(trimmed) ||
        parseMarker(trimmed)?.kind === 'note'
        ? `\\${line}`
        : line;
    })
    .join('\n');
}

/** What an entry's closing lines say about it. */
interface EntryTrailers {
  /** The entry without its closing lines. */
  body: string;
  /** What the hidden lines carry, and the origin when a source line is present. */
  metadata: Record<string, string>;
  /** The hidden chat id, document id and note lines, in the order they sit on disk. */
  hiddenLines: string[];
  /** The external source line nearest the end, as written. */
  externalLine: string | undefined;
  /** Whether a "From you" line is among the closing lines. */
  fromYou: boolean;
}

/**
 * An entry's text split into its body and what its closing lines carry. The origin is the person's
 * only when the entry closes with "From you" and with no external source line; both lines together
 * read as external, so text that reached an entry's end can never raise it.
 */
function splitEntryTrailers(text: string): EntryTrailers {
  const lines = text.split('\n');
  const metadata: Record<string, string> = {};
  const hiddenLines: string[] = [];
  let externalLine: string | undefined;
  let fromYou = false;
  while (lines.length > 0) {
    const line = (lines[lines.length - 1] ?? '').trimEnd();
    const sessionId = SESSION_MARKER_PATTERN.exec(line)?.[1];
    const documentId = DOCUMENT_MARKER_PATTERN.exec(line)?.[1];
    const parsedMarker = parseMarker(line);
    const note = parsedMarker?.kind === 'note' ? parsedMarker : undefined;
    if (line === '') {
      lines.pop();
    } else if (line === FROM_YOU_SOURCE_LINE) {
      fromYou = true;
      lines.pop();
    } else if (isExternalSourceLine(line)) {
      externalLine ??= line;
      lines.pop();
    } else if (sessionId !== undefined) {
      // Every closing marker is dropped; the one nearest the end is the one that counts.
      metadata[SESSION_ID_METADATA_KEY] ??= sessionId;
      hiddenLines.unshift(line);
      lines.pop();
    } else if (documentId !== undefined) {
      metadata[DOCUMENT_ID_METADATA_KEY] ??= documentId;
      hiddenLines.unshift(line);
      lines.pop();
    } else if (note !== undefined) {
      metadata[NOTE_SOURCE_METADATA_KEY] ??= note.source;
      metadata[NOTE_DATE_METADATA_KEY] ??= note.date;
      hiddenLines.unshift(line);
      lines.pop();
    } else {
      break;
    }
  }
  if (externalLine !== undefined) {
    metadata[MEMORY_ORIGIN_METADATA_KEY] = TOOL_INGESTED_ORIGIN;
    // Both closing lines must agree: the hidden note line says it is a reply, and the source line says what it had read.
    if (
      externalLine === REPLY_READ_NOTHING_SOURCE_LINE &&
      metadata[NOTE_SOURCE_METADATA_KEY] === ASSISTANT_RESPONSE_SOURCE
    ) {
      metadata[REPLY_READ_NOTHING_METADATA_KEY] = 'true';
    }
  } else if (fromYou) {
    metadata[MEMORY_ORIGIN_METADATA_KEY] = USER_STATED_ORIGIN;
  }
  return { body: lines.join('\n').trim(), metadata, hiddenLines, externalLine, fromYou };
}

/**
 * Metadata recall hands back for an entry, read from the closing lines `formatRetainEntry` wrote.
 * It always names an origin: an entry with no source line is handed back as read content, because
 * only a written "From you" makes an entry the person's own.
 */
export function entryMetadata(text: string): Record<string, string> {
  const { metadata } = splitEntryTrailers(text);
  return { ...metadata, [MEMORY_ORIGIN_METADATA_KEY]: metadata[MEMORY_ORIGIN_METADATA_KEY] ?? TOOL_INGESTED_ORIGIN };
}

/** The line the Memories page shows for where an entry came from. Old source lines are shown in today's words. */
function readableSourceLine({ metadata, externalLine, fromYou }: EntryTrailers): string {
  if (externalLine === undefined) {
    return fromYou ? FROM_YOU_SOURCE_LINE : NO_RECORD_SOURCE_LINE;
  }
  return externalLine.startsWith(EXTERNAL_SOURCE_LINE_PREFIX) ? externalLine : sourceLineFor(metadata);
}

/** Text as the Memories page or an export holds it, without the closing line that says where it came from. */
export function withoutSourceLines(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0) {
    const line = (lines[lines.length - 1] ?? '').trimEnd();
    if (line !== '' && !isSourceLine(line)) {
      break;
    }
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * An entry's text for matching words. The line that says where it came from is left out, so a
 * question with "you" or "email" in it does not match every note that closes with those words.
 */
export function entryKeywordText(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trimEnd();
      return trimmed !== FROM_YOU_SOURCE_LINE && !trimmed.startsWith(EXTERNAL_SOURCE_LINE_PREFIX);
    })
    .join('\n');
}

/**
 * One daily log written before every entry said where it came from, with a closing source line on each
 * entry. An entry that already names an external source is kept as written. Every other entry has no
 * record of where it came from and is marked that way: a closing "From you" in it was saved as text
 * before that line meant anything, so it stays text. No entry is added, dropped or moved, so every
 * entry id stays the same.
 */
export function withSourceLines(content: string): { content: string; marked: number } {
  let marked = 0;
  const entries = splitEntries(upgradeLegacyEntries(content)).map(entry => {
    const { body, hiddenLines, externalLine, fromYou } = splitEntryTrailers(entry);
    // An erased entry holds only its position and must stay byte-identical to be recognised.
    if (externalLine !== undefined || entry === ERASED_ENTRY) {
      return entry;
    }
    marked += 1;
    const text = fromYou ? `${body}\n\n\\${FROM_YOU_SOURCE_LINE}` : body;
    return [text, ...hiddenLines, NO_RECORD_SOURCE_LINE].join('\n\n');
  });
  return { content: entries.map(entry => `${entry}\n\n`).join(''), marked };
}

/**
 * The entries recall leaves out: those saved in the chat being answered, whose history is already in the
 * conversation. Age never leaves an entry out; recall shows each one with its day.
 */
export function recallExcludedIds({
  entries,
  sessionId,
}: {
  entries: readonly ScannedMemoryEntry[];
  sessionId: string | undefined;
}): Set<string> {
  return new Set(
    entries.filter(entry => isFromSession({ metadata: entryMetadata(entry.text), sessionId })).map(entry => entry.id),
  );
}

/**
 * True for an entry stored as a copy of a replaced document before entries recorded a document id.
 * Such a copy carries no hidden line and no source of its own (a document mirror never recorded a chat
 * or a source; at most it was later marked as having no record), and its body closes with the document's
 * own `> context` line. Any other entry is a chat note or an imported note that merely quotes the line,
 * never a copy.
 */
export function isLegacyDocumentCopy({ text, context }: { text: string; context: string }): boolean {
  const { body, hiddenLines, externalLine, fromYou } = splitEntryTrailers(text);
  const sourceLess = !fromYou && (externalLine === undefined || externalLine === NO_RECORD_SOURCE_LINE);
  if (hiddenLines.length > 0 || !sourceLess) {
    return false;
  }
  const lines = body.split('\n');
  const closing = (lines.pop() ?? '').trim();
  return closing === `> ${context}` && lines.some(line => line.trim() !== '' && !line.startsWith('## '));
}

/**
 * A closing `> ` line that names an internal id, such as `maya:identity`: two short tokens around one
 * colon and no spaces, the first starting with a letter. A readable line such as `> Source: read content`
 * has spaces, and a time such as `> 09:30` starts with a digit, so neither matches.
 */
const HIDDEN_CONTEXT_PATTERN = /^> ([A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z0-9_-]{1,64})$/;

/** A trailer-free body split into its readable text and the id-shaped context line it may close with. */
function splitHiddenContext(body: string): { body: string; context: string | undefined } {
  const lines = body.split('\n');
  const context =
    lines.length > 1 ? HIDDEN_CONTEXT_PATTERN.exec((lines[lines.length - 1] ?? '').trimEnd())?.[1] : undefined;
  if (context === undefined) {
    return { body, context: undefined };
  }
  return { body: lines.slice(0, -1).join('\n').trim(), context };
}

/** The text after an entry's timestamp heading, or the whole text when it has no such heading. */
function withoutHeading(body: string): string {
  return headingInstant(body) === undefined ? body : body.slice(body.indexOf('\n') + 1 || body.length).trim();
}

/**
 * The entry text the Memories page shows and edits: the timestamp heading, the hidden chat id, document id
 * and note lines, and an id-shaped context line are dropped. The page shows the time on its own. The text
 * always closes with one readable line that says where the entry came from.
 */
export function withoutHiddenMarkers(text: string): string {
  const trailers = splitEntryTrailers(text);
  const readable = splitHiddenContext(withoutHeading(trailers.body)).body;
  return `${readable}\n\n${readableSourceLine(trailers)}`;
}

/** The internal id an entry was filed under (its id-shaped `> ` context line), which the page never shows. */
export function hiddenContext(text: string): string | undefined {
  return splitHiddenContext(splitEntryTrailers(text).body).context;
}

/**
 * An entry's page text with its internal id put back as a `> ` line, the shape the daily logs hold:
 * the id line closes the text, and the line that says where the entry came from stays last.
 */
export function withHiddenContext({ text, context }: { text: string; context: string | undefined }): string {
  if (context === undefined) {
    return text;
  }
  const readable = withoutSourceLines(text);
  return `${readable.trimEnd()}\n\n> ${context}${text.slice(readable.length)}`;
}

/** The instant in an entry's `## ` heading, when the heading is a readable timestamp. */
function headingInstant(text: string): string | undefined {
  const heading = text.startsWith('## ') ? (text.split('\n', 1)[0] ?? '').slice(3).trim() : '';
  return /^\d{4}-\d{2}-\d{2}T/.test(heading) && !Number.isNaN(new Date(heading).getTime())
    ? new Date(heading).toISOString()
    : undefined;
}

/**
 * An edited entry's text with the lines the Memories page left out of the original put back: the timestamp
 * heading, the id-shaped context line, and the hidden chat id, document id and note lines. Where the entry
 * came from is always the original's: an edit changes what a note says, never whose words it is.
 */
export function withOriginalHiddenMarkers({ original, edited }: { original: string; edited: string }): string {
  const originalTrailers = splitEntryTrailers(original);
  const { body: originalBody, metadata: kept } = originalTrailers;
  const { body: editedBody, metadata } = splitEntryTrailers(edited);
  const heading =
    headingInstant(originalBody) !== undefined && headingInstant(editedBody) === undefined
      ? [originalBody.split('\n', 1)[0] ?? '']
      : [];
  const context = splitHiddenContext(originalBody).context;
  const body =
    context !== undefined && splitHiddenContext(editedBody).context === undefined
      ? withHiddenContext({ text: editedBody, context })
      : editedBody;
  // A hidden line the edit names itself wins over the original's; the lines keep their on-disk order.
  const trailers: string[] = [];
  const sessionId = metadata[SESSION_ID_METADATA_KEY] ?? kept[SESSION_ID_METADATA_KEY];
  if (sessionId !== undefined) {
    trailers.push(`<!-- session_id: ${sessionId} -->`);
  }
  const documentId = metadata[DOCUMENT_ID_METADATA_KEY] ?? kept[DOCUMENT_ID_METADATA_KEY];
  if (documentId !== undefined) {
    trailers.push(`<!-- document_id: ${documentId} -->`);
  }
  const note = metadata[NOTE_SOURCE_METADATA_KEY] === undefined ? kept : metadata;
  const noteSource = note[NOTE_SOURCE_METADATA_KEY];
  const noteDate = note[NOTE_DATE_METADATA_KEY];
  if (noteSource !== undefined && isMemoryNoteSource(noteSource) && noteDate !== undefined) {
    trailers.push(formatMarker({ kind: 'note', source: noteSource, date: noteDate }));
  }
  if (originalTrailers.externalLine === REPLY_READ_NOTHING_SOURCE_LINE) {
    // The new words are no longer the reply as it was written, so the note is a plain reply note again.
    trailers.push(`${EXTERNAL_SOURCE_LINE_PREFIX}${NOTE_SOURCE_NAMES[ASSISTANT_RESPONSE_SOURCE]}`);
  } else if (originalTrailers.externalLine !== undefined) {
    trailers.push(originalTrailers.externalLine);
  } else if (originalTrailers.fromYou) {
    trailers.push(FROM_YOU_SOURCE_LINE);
  }
  return [...heading, body, ...trailers].join('\n\n');
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
  return withoutHeading(splitEntryTrailers(text).body);
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

/** One daily log as last read from disk, kept so a scan of the whole history only re-reads what changed. */
interface ParsedDailyLog {
  mtimeMs: number;
  size: number;
  ino: number;
  /** False when the file was changed so close to the read that another change could carry the same time. */
  settled: boolean;
  chars: number;
  entries: readonly ScannedMemoryEntry[];
}

/** A file changed this recently is read again next time, however its size and time compare. */
const DAILY_LOG_SETTLE_MS = 2000;

/** Most text kept parsed in this process across every vault; the files read longest ago are dropped first. */
const PARSED_DAILY_LOG_MAX_CHARS = 64 * 1024 * 1024;

/** Daily logs read at once: enough to make a first scan quick, few enough to stay far below the open-file limit. */
const DAILY_LOG_READ_CONCURRENCY = 16;

const parsedDailyLogs = new Map<string, ParsedDailyLog>();
let parsedDailyLogChars = 0;

function forgetParsedDailyLog(filePath: string): void {
  const parsed = parsedDailyLogs.get(filePath);
  if (parsed !== undefined) {
    parsedDailyLogChars -= parsed.chars;
    parsedDailyLogs.delete(filePath);
  }
}

function keepParsedDailyLog({ filePath, parsed }: { filePath: string; parsed: ParsedDailyLog }): void {
  forgetParsedDailyLog(filePath);
  parsedDailyLogs.set(filePath, parsed);
  parsedDailyLogChars += parsed.chars;
  for (const oldest of parsedDailyLogs.keys()) {
    if (parsedDailyLogChars <= PARSED_DAILY_LOG_MAX_CHARS || oldest === filePath) {
      break;
    }
    forgetParsedDailyLog(oldest);
  }
}

/**
 * One daily log's entries. The file is read again whenever its size, time or identity differs from the
 * last read, so an edit made by hand or by another process is seen on the next scan.
 */
async function readDailyLogEntries({
  filePath,
  safeNamespace,
  file,
}: {
  filePath: string;
  safeNamespace: string;
  file: string;
}): Promise<readonly ScannedMemoryEntry[]> {
  let content: string;
  let stats: Stats;
  let readAt: number;
  try {
    stats = await stat(filePath);
    const known = parsedDailyLogs.get(filePath);
    if (
      known?.settled === true &&
      known.mtimeMs === stats.mtimeMs &&
      known.size === stats.size &&
      known.ino === stats.ino
    ) {
      // Re-inserting moves the file to the recently read end.
      parsedDailyLogs.delete(filePath);
      parsedDailyLogs.set(filePath, known);
      return known.entries;
    }
    readAt = Date.now();
    content = await readFile(filePath, 'utf8');
  } catch {
    // A file removed or unreadable mid-scan holds no entries; the rest of the scan goes on.
    forgetParsedDailyLog(filePath);
    return [];
  }
  // Every later scan hands out these same objects, so a caller that changed one would change it for all.
  const entries = Object.freeze(dailyLogEntries({ safeNamespace, file, content }).map(entry => Object.freeze(entry)));
  keepParsedDailyLog({
    filePath,
    parsed: {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      ino: stats.ino,
      settled: readAt - stats.mtimeMs > DAILY_LOG_SETTLE_MS,
      chars: content.length,
      entries,
    },
  });
  return entries;
}

/**
 * Reads a namespace's `MEMORY.md` plus daily logs, newest file first. `maxDailyFiles` bounds the scan
 * for callers that only need recent days; recall, the vault listing and the embedding backfill pass
 * `Infinity` to read the whole history. `resolveTombstones` applies the memory vault's edit/delete
 * markers so listings, recall, and the embedding index all see the effective entries; it defaults to
 * false so raw scans stay byte-identical.
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
  const reviewed = await readReviewedMarks({ baseDir: options.baseDir, namespace: options.namespace });
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
  for (let start = 0; start < files.length; start += DAILY_LOG_READ_CONCURRENCY) {
    const batch = await Promise.all(
      files
        .slice(start, start + DAILY_LOG_READ_CONCURRENCY)
        .map(file => readDailyLogEntries({ filePath: path.join(dir, 'memory', file), safeNamespace, file })),
    );
    for (const fileEntries of batch) {
      // The marks live beside the dated files, so they are applied to each scan and never kept with a parsed file.
      entries.push(...fileEntries.map(entry => withReviewedSource(entry, reviewed)));
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
 * Edits and deletes append a marker block to `.vault-tombstones.md` in the namespace
 * directory, and later markers win per entry id. The dated files are then rewritten in
 * place (see `vaultErase.ts`) so a deleted note's text, and an edited note's old wording,
 * do not stay on disk. Entries keep their positions, so entry indices never shift.
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

export function vaultTombstonesFileFor(baseDir: string, namespace: string): string {
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

export function formatVaultTombstone(tombstone: VaultTombstone): string {
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

/** Appends one vault marker. Call it holding the vault lock. */
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

/** Append-only file in a vault folder that records which older notes the person reviewed as their own. */
export const REVIEWED_FROM_YOU_FILE = '.reviewed-from-you';

/** Reviewed notes: entry id to the hash of the entry text the person reviewed. */
export type ReviewedMarks = ReadonlyMap<string, string>;

/** The hash a review records for an entry: SHA-256 of its whole text as the dated file holds it. */
export function reviewedEntryHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One line of `.reviewed-from-you`: the entry id, a tab, and the hash of the entry as reviewed. */
export function formatReviewedMark({ entryId, text }: { entryId: string; text: string }): string {
  return `${entryId}\t${reviewedEntryHash(text)}`;
}

/** Parses the text of `.reviewed-from-you`; a line that is not an id, a tab and a hash is ignored, and the latest line per id wins. */
export function parseReviewedMarks(content: string): ReviewedMarks {
  const marks = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^(md:[^:\t]+:[^#\t]+#\d+)\t([0-9a-f]{64})$/.exec(line.trimEnd());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      marks.set(match[1], match[2]);
    }
  }
  return marks;
}

/** A namespace's reviewed notes. A missing file reads as none. */
export async function readReviewedMarks(options: { baseDir: string; namespace: string }): Promise<ReviewedMarks> {
  try {
    return parseReviewedMarks(
      await readFile(path.join(namespaceDirFor(options.baseDir, options.namespace), REVIEWED_FROM_YOU_FILE), 'utf8'),
    );
  } catch {
    return new Map();
  }
}

/** The entry's last non-empty line, which closes every entry written since entries name their source. */
function closingLine(text: string): { lines: string[]; index: number } {
  const lines = text.split('\n');
  let index = lines.length - 1;
  while (index >= 0 && (lines[index] ?? '').trim() === '') {
    index -= 1;
  }
  return { lines, index };
}

/**
 * The chat id of an older note that is open to review: it closes with exactly "External source: no record",
 * names a chat, and is not a note from a document or email. Undefined for any other entry.
 */
export function reviewableNoRecordChatId(text: string): string | undefined {
  const { lines, index } = closingLine(text);
  if ((lines[index] ?? '').trimEnd() !== NO_RECORD_SOURCE_LINE) {
    return undefined;
  }
  const metadata = splitEntryTrailers(text).metadata;
  return metadata[NOTE_SOURCE_METADATA_KEY] === undefined ? metadata[SESSION_ID_METADATA_KEY] : undefined;
}

/**
 * Hands an entry on as the person's own words when they reviewed it: its id is recorded with the hash of
 * this very text and it still closes with exactly "External source: no record". Only that line changes.
 * A hash that no longer matches, or any other closing line, leaves the entry as it is. Applied when entries
 * are scanned, before vault markers, so every reader and a later edit see the reviewed source.
 */
function withReviewedSource(entry: ScannedMemoryEntry, reviewed: ReviewedMarks): ScannedMemoryEntry {
  if (reviewed.get(entry.id) !== reviewedEntryHash(entry.text)) {
    return entry;
  }
  const { lines, index } = closingLine(entry.text);
  if ((lines[index] ?? '').trimEnd() !== NO_RECORD_SOURCE_LINE) {
    return entry;
  }
  lines[index] = FROM_YOU_SOURCE_LINE;
  return { ...entry, text: lines.join('\n') };
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
  /** The internal id the entry was filed under, when it has one; left out of `text`. */
  context?: string;
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
  /** Newest daily files read; the whole history when left out. */
  maxDailyFiles?: number;
}): Promise<VaultScannedEntry[]> {
  const scan = await scanNamespaceEntries({
    baseDir: options.baseDir,
    namespace: options.namespace,
    maxDailyFiles: options.maxDailyFiles ?? Number.POSITIVE_INFINITY,
  });
  const tombstones = await readVaultTombstones({ baseDir: options.baseDir, namespace: options.namespace });
  const latest = latestTombstonesByEntry(tombstones);
  return applyVaultTombstones(scan.entries, tombstones).map(entry => {
    const tombstone = latest.get(entry.id);
    const context = hiddenContext(entry.text);
    return {
      id: entry.id,
      text: withoutHiddenMarkers(entry.text),
      timestamp: tombstone?.action === 'updated' ? tombstone.timestamp : vaultEntryTimestamp(entry),
      ...(context === undefined ? {} : { context }),
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
