import type { ToolResultSource } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';
import { MEMORY_ORIGIN_METADATA_KEY } from './memoryOrigin';

/** Metadata key naming where a note came from. Notes the person said carry no such key. */
export const NOTE_SOURCE_METADATA_KEY = 'note_source';

/** Metadata key holding the day (YYYY-MM-DD) a note was found or given. */
export const NOTE_DATE_METADATA_KEY = 'note_date';

/** Stored source of a note that records what the assistant told the person. */
export const ASSISTANT_RESPONSE_SOURCE = 'assistant_response';

/**
 * Metadata key (value `true`) on a reply note written when the chat had read nothing from outside up to that
 * reply. Only the save sets it. A reply note without it may repeat something the assistant read.
 */
export const REPLY_READ_NOTHING_METADATA_KEY = 'reply_read_nothing';

/** Whether a stored item is a reply note that says its chat had read nothing from outside. */
export function isReplyThatReadNothing(metadata: Readonly<Record<string, string>> | undefined): boolean {
  return (
    metadata?.[NOTE_SOURCE_METADATA_KEY] === ASSISTANT_RESPONSE_SOURCE &&
    metadata[REPLY_READ_NOTHING_METADATA_KEY] === 'true'
  );
}

/** Stored source of a note that records a message the person sent through the assistant. */
export const SENT_MAIL_SOURCE = 'sent_mail';

/** Where a saved note came from: a kind of tool result, the assistant's own reply, or a message the person sent. */
export type MemoryNoteSource = ToolResultSource | typeof ASSISTANT_RESPONSE_SOURCE | typeof SENT_MAIL_SOURCE;

const NOTE_SOURCES = [
  'email',
  'calendar',
  'web',
  'attachment',
  'other',
  'sent_mail',
  'assistant_response',
] as const satisfies readonly MemoryNoteSource[];

export function isMemoryNoteSource(value: string): value is MemoryNoteSource {
  return NOTE_SOURCES.some(source => source === value);
}

/** Where a note came from and the day it was found or given. */
export interface NoteProvenance {
  source: MemoryNoteSource;
  date: string;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const NOTE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A note's text split into its body and the marker on its last line, when it ends with one. */
function splitNoteTrailer(text: string): { body: string; provenance: NoteProvenance | undefined } {
  const trimmed = text.trimEnd();
  const lastLineStart = trimmed.lastIndexOf('\n') + 1;
  const marker = parseMarker(trimmed.slice(lastLineStart));
  return marker?.kind === 'note'
    ? { body: trimmed.slice(0, lastLineStart).trimEnd(), provenance: { source: marker.source, date: marker.date } }
    : { body: text, provenance: undefined };
}

/** The stored text of a note: its labeled sentence, then the hidden marker. */
export function noteRetainContent({ text, source, date }: { text: string } & NoteProvenance): string {
  return `${text}\n\n${formatMarker({ kind: 'note', source, date })}`;
}

/** A note's text without the hidden marker, for showing to the model or the person. */
export function withoutNoteTrailer(text: string): string {
  return splitNoteTrailer(text).body;
}

/** Where a note came from and when, as its metadata says; undefined when the metadata names no note source. */
export function noteProvenanceFromMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): NoteProvenance | undefined {
  const source = metadata?.[NOTE_SOURCE_METADATA_KEY];
  if (source === undefined || !isMemoryNoteSource(source)) {
    return undefined;
  }
  return { source, date: metadata?.[NOTE_DATE_METADATA_KEY] ?? '' };
}

/**
 * Where a recalled item came from and when. The metadata is the authority; the text's marker is read
 * only when the store handed back no metadata at all (no origin, no note source), so a marker that
 * something outside the chat slipped into an ordinary entry never turns that entry into a note.
 * Undefined for something the person said.
 */
export function noteProvenance({
  metadata,
  text,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  text: string;
}): NoteProvenance | undefined {
  const fromMetadata = noteProvenanceFromMetadata(metadata);
  if (fromMetadata !== undefined) {
    return fromMetadata;
  }
  return metadata?.[MEMORY_ORIGIN_METADATA_KEY] === undefined ? splitNoteTrailer(text).provenance : undefined;
}

/** `Oct 29` for a `YYYY-MM-DD` day, or undefined when the day is not a real date. */
function monthAndDay(date: string): string | undefined {
  const match = NOTE_DATE_PATTERN.exec(date);
  const month = MONTH_NAMES[Number(match?.[2]) - 1];
  return match === null || month === undefined || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    ? undefined
    : `${month} ${String(Number(match[3]))}`;
}

const FINDING_SOURCE_PHRASES: Record<ToolResultSource | typeof SENT_MAIL_SOURCE, string> = {
  email: 'an email',
  calendar: 'the calendar',
  web: 'the web',
  attachment: 'an attachment',
  other: 'another tool',
  sent_mail: 'a message you sent',
};

/**
 * The label written at the start of a note's text, so the Memories page and the model both see where
 * it came from and when: "From an email, found Oct 29" or "From <assistant name>'s reply, Oct 29".
 */
export function noteLabel({
  source,
  date,
  assistantName,
}: {
  source: MemoryNoteSource;
  date: string;
  assistantName: string | undefined;
}): string {
  const day = monthAndDay(date) ?? date;
  if (source === ASSISTANT_RESPONSE_SOURCE) {
    return `From ${assistantName ?? 'the assistant'}'s reply, ${day}`;
  }
  // A sent message was written by the person, not found, so its label has no "found".
  return source === SENT_MAIL_SOURCE
    ? `From ${FINDING_SOURCE_PHRASES[source]}, ${day}`
    : `From ${FINDING_SOURCE_PHRASES[source]}, found ${day}`;
}

/** The note's text as saved: its label, then the fact. */
export function labeledNoteText({ label, text }: { label: string; text: string }): string {
  return `${label}: ${text}`;
}

/** Any label `noteLabel` writes, with the colon after it. The assistant's name in a reply label can be any short text. */
const NOTE_LABEL_PATTERN = new RegExp(
  `^From (?:[^\\n]{1,80}?(?:'s|’s) reply|(?:${Object.values(FINDING_SOURCE_PHRASES).join('|')})(?:, found)?),? [^:\\n]{1,20}: `,
);

/**
 * A saved note without its label. The label says where the note came from, and a reply's label names the
 * assistant, so a reader that is told the origin apart must not take the label for part of what was said.
 */
export function noteTextWithoutLabel(text: string): string {
  return text.replace(NOTE_LABEL_PATTERN, '');
}

/**
 * Where a fact on a page came from. The model never chooses it. `you_said` and `you_edited` are the person's own words.
 */
export const FACT_SOURCES = [
  'you_said',
  'you_edited',
  'sent_mail',
  'mail',
  'calendar',
  'read_content',
  'inferred',
] as const;

const FactSourceSchema = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof FactSourceSchema>;

/** A fact's day at year, month, or day precision. */
const FactDateSchema = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/);

/** Fact ids are `f_` and a short lowercase token. */
const FactIdSchema = z.string().regex(/^f_[a-z0-9]{1,16}$/);

const NoteMarkerSchema = z.strictObject({
  kind: z.literal('note'),
  source: z.enum(NOTE_SOURCES),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * The fact variant of the hidden marker at the end of one page bullet. `seen` is for facts on probation
 * (Unconfirmed); `since` and `until` are for facts that are or were true.
 */
export const FactMarkerSchema = z.strictObject({
  kind: z.literal('fact'),
  id: FactIdSchema,
  src: FactSourceSchema,
  since: FactDateSchema.optional(),
  until: FactDateSchema.optional(),
  seen: FactDateSchema.optional(),
});
export type FactMarker = z.infer<typeof FactMarkerSchema>;

/**
 * Every hidden `<!-- kind: ... -->` marker. A note marker rides at the end of a daily-log entry and carries
 * its source and day; a fact marker rides at the end of a page bullet. This is the one owner of both grammars.
 */
const MarkerSchema = z.discriminatedUnion('kind', [NoteMarkerSchema, FactMarkerSchema]);
export type Marker = z.infer<typeof MarkerSchema>;

const MARKER_PATTERN = /^<!--\s*([a-z]+):\s*(.*?)\s*-->$/;

/** A marker line cut into its kind and its whitespace-separated body tokens. */
function tokenizeMarker(line: string): { kind: string; tokens: string[] } | undefined {
  const match = MARKER_PATTERN.exec(line);
  const kind = match?.[1];
  const body = match?.[2];
  return kind === undefined || body === undefined ? undefined : { kind, tokens: body.split(/\s+/).filter(Boolean) };
}

/** Note tokens are positional (`<source> <date>`, as logs already hold them); fact tokens are `key=value`. */
function markerFields({ kind, tokens }: { kind: string; tokens: string[] }): Record<string, string> | undefined {
  if (kind === 'note') {
    const [source, date, ...rest] = tokens;
    return source === undefined || date === undefined || rest.length > 0 ? undefined : { kind, source, date };
  }
  const fields: Record<string, string> = { kind };
  for (const token of tokens) {
    const separator = token.indexOf('=');
    const key = token.slice(0, separator);
    if (separator === -1 || key in fields) {
      return undefined;
    }
    fields[key] = token.slice(separator + 1);
  }
  return fields;
}

/** The hidden marker a note or a page bullet carries, written the way `parseMarker` reads it. */
export function formatMarker(marker: Marker): string {
  if (marker.kind === 'note') {
    return `<!-- note: ${marker.source} ${marker.date} -->`;
  }
  const fields = [`id=${marker.id}`, `src=${marker.src}`];
  for (const key of ['since', 'until', 'seen'] as const) {
    const value = marker[key];
    if (value !== undefined) {
      fields.push(`${key}=${value}`);
    }
  }
  return `<!-- fact: ${fields.join(' ')} -->`;
}

/**
 * The marker a line carries, or undefined when the line is not a well-formed marker. Fact markers accept any
 * run of spaces between keys; note markers must be written exactly as `formatMarker` writes them.
 */
export function parseMarker(line: string): Marker | undefined {
  const tokenized = tokenizeMarker(line.trim());
  const fields = tokenized === undefined ? undefined : markerFields(tokenized);
  const parsed = MarkerSchema.safeParse(fields);
  if (!parsed.success || (parsed.data.kind === 'note' && formatMarker(parsed.data) !== line.trimEnd())) {
    return undefined;
  }
  return parsed.data;
}

/** A bullet's text split from the fact marker that ends it; `marker` is undefined when the line has none. */
export function splitFactMarker(line: string): { text: string; marker: FactMarker | undefined } {
  const start = line.lastIndexOf('<!--');
  if (start === -1) {
    return { text: line, marker: undefined };
  }
  const marker = parseMarker(line.slice(start));
  return marker?.kind === 'fact' ? { text: line.slice(0, start).trimEnd(), marker } : { text: line, marker: undefined };
}
