/**
 * Resolves the caller-supplied IANA timezone (AgentDefinition.clientTimezone) into local
 * date/time fields, falling back to UTC when no zone was supplied or the supplied name is not
 * a real IANA zone. Shared by the get_current_datetime host tool and AgentThread's ambient
 * current-date section, so both report the same local time the same way.
 */

export const FALLBACK_TIMEZONE = 'UTC';

export interface LocalTimeInfo {
  /** IANA zone actually used: the caller-supplied zone, or 'UTC' on fallback. */
  zone: string;
  /** true when the caller-supplied zone was missing or invalid and UTC was used instead. */
  isFallback: boolean;
  /** Signed offset from UTC at `date`, e.g. '-07:00' or '+05:30'. */
  utcOffset: string;
  /** Calendar date in `zone`, 'YYYY-MM-DD'. */
  date: string;
  /** Wall-clock time in `zone`, 'HH:MM:SS' (24-hour). */
  time: string;
}

/** True when `timezone` is a name `Intl.DateTimeFormat` accepts as a IANA time zone. */
export function isValidTimezone(timezone: string): boolean {
  try {
    // Constructed only to validate; the value itself is discarded immediately.
    void new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function datePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find(part => part.type === type)?.value ?? '00';
}

/** Signed 'HH:MM' → '+HH:MM' / '-HH:MM' UTC offset for `zone` at `now`, via Intl's shortOffset. */
function utcOffsetAt(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now);
  const label = parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(label);
  if (!match) {
    return '+00:00';
  }
  const hours = Number(match[1]);
  const minutes = match[2] ?? '00';
  const sign = hours < 0 ? '-' : '+';
  return `${sign}${String(Math.abs(hours)).padStart(2, '0')}:${minutes}`;
}

/** Minutes `zone` is ahead of UTC at `instant`. */
export function utcOffsetMinutes({ instant, zone }: { instant: Date; zone: string }): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffsetAt(instant, zone));
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** Resolves `timezone` to local date/time fields at `now`, falling back to UTC when needed. */
export function resolveLocalTime(now: Date, timezone: string | undefined): LocalTimeInfo {
  const isFallback = timezone === undefined || timezone.length === 0 || !isValidTimezone(timezone);
  const zone = isFallback ? FALLBACK_TIMEZONE : timezone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const date = `${datePart(parts, 'year')}-${datePart(parts, 'month')}-${datePart(parts, 'day')}`;
  // en-CA with hour12: false renders midnight as '24'; normalize to '00' for a valid HH:MM:SS.
  const hour = datePart(parts, 'hour') === '24' ? '00' : datePart(parts, 'hour');
  const time = `${hour}:${datePart(parts, 'minute')}:${datePart(parts, 'second')}`;
  return { zone, isFallback, utcOffset: utcOffsetAt(now, zone), date, time };
}
