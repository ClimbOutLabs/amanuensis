/** Calendar days in the demo user's time zone; the seed never reads the machine's zone. */
import { addDays, type CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';

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

/** Calendar labels for the days around a seed day, by offset from it. */
export interface DayLabels {
  /** `Tuesday` */
  weekday(offset: number): string;
  /** `Oct 27` */
  monthDay(offset: number): string;
  /** `Tuesday, October 27` */
  long(offset: number): string;
}

function formatUtcNoon({ day, options }: { day: CalendarDay; options: Intl.DateTimeFormatOptions }): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    new Date(Date.UTC(day.year, day.month - 1, day.day, 12)),
  );
}

export function dayLabels(today: CalendarDay): DayLabels {
  const at = (offset: number): CalendarDay => addDays({ day: today, days: offset });
  return {
    weekday: offset => formatUtcNoon({ day: at(offset), options: { weekday: 'long' } }),
    monthDay: offset => formatUtcNoon({ day: at(offset), options: { month: 'short', day: 'numeric' } }),
    long: offset => longDayLabel(at(offset)),
  };
}
