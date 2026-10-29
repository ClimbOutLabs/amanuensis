import type { ToolResultSource } from '@truefoundry/trueforge-core/core';

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

/** Notes older than this stay stored but are not recalled, because what an assistant found goes out of date. */
export const RECALLED_NOTE_MAX_AGE_DAYS = 14;

const MILLISECONDS_PER_DAY = 86_400_000;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const NOTE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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
 * it came from and when: "From an email, found Oct 29" or "From Nata's reply, Oct 29".
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
 * Whether a recalled item is a note more than the limit's whole days old. A note whose date cannot be read counts as too old,
 * because its age cannot be checked. Items that are not notes are never too old.
 */
export function isNoteTooOld({
  metadata,
  now,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  now: Date;
}): boolean {
  if (metadata?.[NOTE_SOURCE_METADATA_KEY] === undefined) {
    return false;
  }
  const date = metadata[NOTE_DATE_METADATA_KEY] ?? '';
  const found = NOTE_DATE_PATTERN.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  return Number.isNaN(found) || Math.floor((now.getTime() - found) / MILLISECONDS_PER_DAY) > RECALLED_NOTE_MAX_AGE_DAYS;
}

/** The note kind a recalled item carries, or undefined for something the person said. */
export function recalledNoteSource(
  metadata: Readonly<Record<string, string>> | undefined,
): MemoryNoteSource | undefined {
  const source = metadata?.[NOTE_SOURCE_METADATA_KEY];
  return source !== undefined && isMemoryNoteSource(source) ? source : undefined;
}
