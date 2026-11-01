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

const NOTE_SOURCES: readonly MemoryNoteSource[] = [
  'email',
  'calendar',
  'web',
  'attachment',
  'other',
  'assistant_response',
];

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

/**
 * Hidden trailer line carrying a note's source and day. It travels inside the note's stored text, so every
 * store hands it back at recall, and it is the one place the source and day are read from.
 */
const NOTE_MARKER_PATTERN = /^<!-- note: ([a-z_]{1,32}) (\d{4}-\d{2}-\d{2}) -->$/;

export function formatNoteMarker({ source, date }: NoteProvenance): string {
  return `<!-- note: ${source} ${date} -->`;
}

/** The provenance a trailer line carries, or undefined when the line is not a note marker with a known source. */
export function parseNoteMarker(line: string): NoteProvenance | undefined {
  const match = NOTE_MARKER_PATTERN.exec(line.trimEnd());
  const source = match?.[1];
  const date = match?.[2];
  return source !== undefined && date !== undefined && isMemoryNoteSource(source) ? { source, date } : undefined;
}

/** A note's text split into its body and the marker on its last line, when it ends with one. */
function splitNoteTrailer(text: string): { body: string; provenance: NoteProvenance | undefined } {
  const trimmed = text.trimEnd();
  const lastLineStart = trimmed.lastIndexOf('\n') + 1;
  const provenance = parseNoteMarker(trimmed.slice(lastLineStart));
  return provenance === undefined
    ? { body: text, provenance: undefined }
    : { body: trimmed.slice(0, lastLineStart).trimEnd(), provenance };
}

/** The stored text of a note: its labeled sentence, then the hidden marker. */
export function noteRetainContent({ text, source, date }: { text: string } & NoteProvenance): string {
  return `${text}\n\n${formatNoteMarker({ source, date })}`;
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

/**
 * The hidden marker at the end of one page bullet. `seen` is for facts on probation (Unconfirmed);
 * `since` and `until` are for facts that are or were true. Keys render in this order.
 */
export const FactMarkerSchema = z.strictObject({
  id: FactIdSchema,
  src: FactSourceSchema,
  since: FactDateSchema.optional(),
  until: FactDateSchema.optional(),
  seen: FactDateSchema.optional(),
});
export type FactMarker = z.infer<typeof FactMarkerSchema>;

const FACT_MARKER_KEYS = ['id', 'src', 'since', 'until', 'seen'] as const;

/** A fact marker as it sits at the end of a bullet; any run of spaces is accepted between its keys. */
const FACT_MARKER_PATTERN = /^<!--\s*fact:\s*((?:[a-z]+=[^\s]+\s*)+)-->$/;

export function formatFactMarker(marker: FactMarker): string {
  const parts: string[] = [];
  for (const key of FACT_MARKER_KEYS) {
    const value = marker[key];
    if (value !== undefined) {
      parts.push(`${key}=${value}`);
    }
  }
  return `<!-- fact: ${parts.join(' ')} -->`;
}

/** The marker a fact-marker line carries, or undefined when the line is not a well-formed fact marker. */
export function parseFactMarker(line: string): FactMarker | undefined {
  const body = FACT_MARKER_PATTERN.exec(line.trim())?.[1];
  if (body === undefined) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const pair of body.trim().split(/\s+/)) {
    const separator = pair.indexOf('=');
    const key = pair.slice(0, separator);
    if (key in fields) {
      return undefined;
    }
    fields[key] = pair.slice(separator + 1);
  }
  const parsed = FactMarkerSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

/** A bullet's text split from the fact marker that ends it; `marker` is undefined when the line has none. */
export function splitFactMarker(line: string): { text: string; marker: FactMarker | undefined } {
  const start = line.lastIndexOf('<!--');
  if (start === -1) {
    return { text: line, marker: undefined };
  }
  const marker = parseFactMarker(line.slice(start));
  return marker === undefined ? { text: line, marker: undefined } : { text: line.slice(0, start).trimEnd(), marker };
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
