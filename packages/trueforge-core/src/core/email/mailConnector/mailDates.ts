import { zonedInstant } from '../../calendar/timeRange';
import { isRealDate, parseDateOnly } from '../../util/calendarDay';
import { FALLBACK_TIMEZONE, isValidTimezone } from '../../util/clientTimezone';

/** The list arguments that name a moment. The sidecar refuses a moment with no offset, so the host adds one. */
const DATE_ARGUMENTS = ['since', 'before'] as const;

/** `2026-10-28T08:00`, with optional seconds and fraction, and no offset. */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3})\d*)?)?$/;
/** A clock time followed by `Z` or a signed offset, so the `-28` of a bare date is never read as one. */
const ENDS_WITH_OFFSET = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

export type MailDates = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * The moment a date text names, as an offset timestamp the sidecar takes. A text with its own offset is kept as
 * it is; a bare date starts that day and a bare time is read in the zone. Undefined when the text is not a date.
 */
export function mailDateInstant({ text, zone }: { text: string; zone: string }): string | undefined {
  if (ENDS_WITH_OFFSET.test(text)) {
    return Number.isNaN(Date.parse(text)) ? undefined : text;
  }
  if (isRealDate(text)) {
    return zonedInstant({ date: text, hour: 0, minute: 0, zone }).toISOString();
  }
  const match = LOCAL_DATE_TIME.exec(text);
  const date = match?.[1];
  if (match === null || date === undefined || parseDateOnly(date) === undefined) {
    return undefined;
  }
  const minute = zonedInstant({ date, hour: Number(match[2]), minute: Number(match[3]), zone });
  const seconds = Number(match[4] ?? '0');
  const millis = Number((match[5] ?? '0').padEnd(3, '0'));
  return new Date(minute.getTime() + seconds * 1000 + millis).toISOString();
}

/**
 * The list arguments with each date the model gave as an offset timestamp, read in the user's zone (UTC when no
 * real zone is known). A date text that names no date is refused in plain words; a value that is not text is
 * left for the sidecar to judge.
 */
export function resolveMailDates({
  args,
  time_zone,
}: {
  args: Record<string, unknown>;
  time_zone: string | undefined;
}): MailDates {
  const zone = time_zone !== undefined && isValidTimezone(time_zone) ? time_zone : FALLBACK_TIMEZONE;
  const resolved = { ...args };
  for (const key of DATE_ARGUMENTS) {
    const given = args[key];
    if (typeof given !== 'string') {
      continue;
    }
    const instant = mailDateInstant({ text: given, zone });
    if (instant === undefined) {
      return {
        ok: false,
        error: `${key} is not a date. Give it as a date like 2026-10-28 or a time like 2026-10-28T08:00:00, with or without a time zone offset.`,
      };
    }
    resolved[key] = instant;
  }
  return { ok: true, args: resolved };
}
