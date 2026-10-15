/** Calendar days in the demo user's time zone; the seed never reads the machine's zone. */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

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

export function addDays({ day, days }: { day: CalendarDay; days: number }): CalendarDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** 0 is Sunday ... 6 is Saturday. */
export function weekdayOf(day: CalendarDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, 12)).getUTCDay();
}

/** `2026-10-15`; also the stable per-day key stored on seeded records. */
export function isoDay(day: CalendarDay): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(day.year)}-${two(day.month)}-${two(day.day)}`;
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
