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

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses `YYYY-MM-DD`; undefined for anything else, including a day that does not exist (such as 2026-02-30). */
export function parseIsoDay(text: string): CalendarDay | undefined {
  const match = ISO_DAY.exec(text);
  if (match === null) {
    return undefined;
  }
  const day: CalendarDay = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isoDay(addDays({ day, days: 0 })) === text ? day : undefined;
}

/** Calendar labels for the days around a seed day, by offset from it. */
export interface DayLabels {
  day(offset: number): CalendarDay;
  iso(offset: number): string;
  /** `Tuesday` */
  weekday(offset: number): string;
  /** `Tue` */
  shortWeekday(offset: number): string;
  /** `Oct 27` */
  monthDay(offset: number): string;
  /** `Tuesday, October 27` */
  long(offset: number): string;
  /** `Wednesday, October 28, 2026` */
  longWithYear(offset: number): string;
}

function formatUtcNoon({ day, options }: { day: CalendarDay; options: Intl.DateTimeFormatOptions }): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    new Date(Date.UTC(day.year, day.month - 1, day.day, 12)),
  );
}

export function dayLabels(today: CalendarDay): DayLabels {
  const at = (offset: number): CalendarDay => addDays({ day: today, days: offset });
  return {
    day: at,
    iso: offset => isoDay(at(offset)),
    weekday: offset => formatUtcNoon({ day: at(offset), options: { weekday: 'long' } }),
    shortWeekday: offset => formatUtcNoon({ day: at(offset), options: { weekday: 'short' } }),
    monthDay: offset => formatUtcNoon({ day: at(offset), options: { month: 'short', day: 'numeric' } }),
    long: offset => longDayLabel(at(offset)),
    longWithYear: offset =>
      formatUtcNoon({ day: at(offset), options: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } }),
  };
}
