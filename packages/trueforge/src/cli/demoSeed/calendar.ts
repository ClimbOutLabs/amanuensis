/** Calendar days in the demo user's time zone; the seed never reads the machine's zone. */
import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';

function partValue({ parts, type }: { parts: Intl.DateTimeFormatPart[]; type: Intl.DateTimeFormatPartTypes }): number {
  const part = parts.find(candidate => candidate.type === type);
  if (part === undefined) {
    throw new Error(`Date formatting returned no ${type} part.`);
  }
  return Number(part.value);
}

/** The calendar day `now` falls on in `timeZone`. */
export function dayInZone({ now, timeZone }: { now: Date; timeZone: string }): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  return {
    year: partValue({ parts, type: 'year' }),
    month: partValue({ parts, type: 'month' }),
    day: partValue({ parts, type: 'day' }),
  };
}

/** `Thursday, October 15`; a calendar label has no zone, so it is formatted from UTC noon. */
export function longDayLabel(day: CalendarDay): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(day.year, day.month - 1, day.day, 12)));
}

/** `3:20 pm` */
export function clockLabel({ hour, minute }: { hour: number; minute: number }): string {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelveHour)}:${String(minute).padStart(2, '0')} ${suffix}`;
}
