import type { ToolResultSource } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';
import { MEMORY_ORIGIN_METADATA_KEY } from './memoryOrigin';

/** Metadata key naming where a note came from. Notes the person said carry no such key. */
export const NOTE_SOURCE_METADATA_KEY = 'note_source';

/** Metadata key holding the day (YYYY-MM-DD) a note was found or given. */
export const NOTE_DATE_METADATA_KEY = 'note_date';

/** Stored source of a note that records what the assistant told the person. */
export const ASSISTANT_RESPONSE_SOURCE = 'assistant_response';

/** Where a saved note came from: a kind of tool result, or the assistant's own reply. */
export type MemoryNoteSource = ToolResultSource | typeof ASSISTANT_RESPONSE_SOURCE;

const NOTE_SOURCES = [
  'email',
  'calendar',
  'web',
  'attachment',
  'other',
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

/**
 * Read content (findings from emails, web pages, documents) older than this stays stored but is not recalled,
 * because it goes out of date; the assistant's own replies never age out, so "what did you advise me" stays recallable.
 */
export const READ_CONTENT_NOTE_MAX_AGE_DAYS = 14;

const MILLISECONDS_PER_DAY = 86_400_000;

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

const FINDING_SOURCE_PHRASES: Record<ToolResultSource, string> = {
  email: 'an email',
  calendar: 'the calendar',
  web: 'the web',
  attachment: 'an attachment',
  other: 'another tool',
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
  return source === ASSISTANT_RESPONSE_SOURCE
    ? `From ${assistantName ?? 'the assistant'}'s reply, ${day}`
    : `From ${FINDING_SOURCE_PHRASES[source]}, found ${day}`;
}

/** The note's text as saved: its label, then the fact. */
export function labeledNoteText({ label, text }: { label: string; text: string }): string {
  return `${label}: ${text}`;
}

/**
 * Whether a recalled item is a note more than the limit's whole days old, counted in UTC days. A day in the
 * future counts as today, so a wrong clock never keeps a note forever. A note whose date cannot be read
 * counts as too old, because its age cannot be checked. Items that are not notes are never too old.
 */
export function isNoteTooOld({
  metadata,
  text,
  now,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  text: string;
  now: Date;
}): boolean {
  const provenance = noteProvenance({ metadata, text });
  if (provenance === undefined || provenance.source === ASSISTANT_RESPONSE_SOURCE) {
    return false;
  }
  const found = NOTE_DATE_PATTERN.test(provenance.date) ? Date.parse(`${provenance.date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(found)) {
    return true;
  }
  const today = Math.floor(now.getTime() / MILLISECONDS_PER_DAY);
  const foundDay = Math.min(Math.floor(found / MILLISECONDS_PER_DAY), today);
  return today - foundDay > READ_CONTENT_NOTE_MAX_AGE_DAYS;
}

/**
 * Where a fact on a page came from. The host sets this from the log entry's origin and note source;
 * the model never chooses it. `you_said` and `you_edited` are the person's own words and are never
 * rewritten by the nightly pass.
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

export const FactSourceSchema = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof FactSourceSchema>;

/** A fact's day at year, month, or day precision. */
export const FactDateSchema = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/);
export type FactDate = z.infer<typeof FactDateSchema>;

/** Fact ids are `f_` and a short lowercase token, unique within a vault for the life of the fact. */
export const FactIdSchema = z.string().regex(/^f_[a-z0-9]{1,16}$/);
export type FactId = z.infer<typeof FactIdSchema>;

const NoteMarkerSchema = z.strictObject({
  kind: z.literal('note'),
  source: z.enum(NOTE_SOURCES),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * The fact variant of the hidden marker at the end of one page bullet. `seen` is for facts on probation
 * (Unconfirmed); `since` and `until` are for facts that are or were true. Keys render in this order.
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
export const MarkerSchema = z.discriminatedUnion('kind', [NoteMarkerSchema, FactMarkerSchema]);
export type Marker = z.infer<typeof MarkerSchema>;

const FACT_MARKER_KEYS = ['id', 'src', 'since', 'until', 'seen'] as const;

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

export function formatMarker(marker: Marker): string {
  if (marker.kind === 'note') {
    return `<!-- note: ${marker.source} ${marker.date} -->`;
  }
  const parts: string[] = [];
  for (const key of FACT_MARKER_KEYS) {
    const value = marker[key];
    if (value !== undefined) {
      parts.push(`${key}=${value}`);
    }
  }
  return `<!-- fact: ${parts.join(' ')} -->`;
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

/** The first and last calendar day a fact date covers, so dates of any precision compare as day ranges. */
export function factDateBounds(date: FactDate): { first: string; last: string } {
  const [year, month, day] = date.split('-');
  if (day !== undefined) {
    return { first: date, last: date };
  }
  if (month !== undefined) {
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return { first: `${date}-01`, last: `${date}-${String(lastDay).padStart(2, '0')}` };
  }
  return { first: `${date}-01-01`, last: `${date}-12-31` };
}

/** Whether a fact with this `until` has ended as of `today` (a `YYYY-MM-DD` day): its last covered day is before today. */
export function factHasEnded({ until, today }: { until: FactDate; today: string }): boolean {
  return factDateBounds(until).last < today;
}
