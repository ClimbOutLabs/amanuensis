/** Calendar days without a time zone: parsing a date, stepping it, and naming its weekday. */

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The day a `YYYY-MM-DD` text names; undefined for other text and for dates that do not exist, like 2026-02-30. */
export function parseDateOnly(text: string): CalendarDay | undefined {
  const match = DATE_ONLY.exec(text);
  if (match === null) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

export function isRealDate(text: string): boolean {
  return parseDateOnly(text) !== undefined;
}

export function addDays({ day, days }: { day: CalendarDay; days: number }): CalendarDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** `2026-10-15`; also the stable per-day key stored on seeded records. */
export function isoDay(day: CalendarDay): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(day.year)}-${two(day.month)}-${two(day.day)}`;
}

/** 0 is Sunday ... 6 is Saturday. */
export function weekdayOf(day: CalendarDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, 12)).getUTCDay();
}

/** The English weekday name of a `YYYY-MM-DD` date. */
export function weekdayNameOf(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`));
}
