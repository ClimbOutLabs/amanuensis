/** Turns the days and moments a caller names into the instants Google wants, reading a bare date in the user's time zone. */
import { addDays, isoDay, isRealDate, parseDateOnly } from '../util/calendarDay';
import { utcOffsetMinutes } from '../util/clientTimezone';
import { MAX_RANGE_DAYS } from './toolContract';

const MS_PER_DAY = 86_400_000;
/** The instant a calendar day begins in the zone. Checked twice, so a day that starts across a clock change is right. */
function startOfDay({ date, zone }: { date: string; zone: string }): Date {
  const parsed = parseDateOnly(date);
  const wallClock = parsed === undefined ? Number.NaN : Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const first = wallClock - utcOffsetMinutes({ instant: new Date(wallClock), zone }) * 60_000;
  const second = wallClock - utcOffsetMinutes({ instant: new Date(first), zone }) * 60_000;
  return new Date(second);
}

/** The calendar date before or after another; the text is returned unchanged when it is not a real date. */
export function shiftDate({ date, days }: { date: string; days: number }): string {
  const parsed = parseDateOnly(date);
  return parsed === undefined ? date : isoDay(addDays({ day: parsed, days }));
}

export type Bounds = { ok: true; timeMin: string; timeMax: string } | { ok: false; error: string };

/** A start date begins that day and an end date includes it whole; a moment with an offset is used as it is. */
export function resolveBounds(input: { time_min: string; time_max: string; zone: string }): Bounds {
  const min = isRealDate(input.time_min)
    ? startOfDay({ date: input.time_min, zone: input.zone })
    : new Date(input.time_min);
  const max = isRealDate(input.time_max)
    ? startOfDay({ date: shiftDate({ date: input.time_max, days: 1 }), zone: input.zone })
    : new Date(input.time_max);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime())) {
    return { ok: false, error: 'The dates were not valid.' };
  }
  if (max.getTime() <= min.getTime()) {
    return { ok: false, error: 'time_max must be after time_min.' };
  }
  if (max.getTime() - min.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
    return { ok: false, error: `Ask for ${String(MAX_RANGE_DAYS)} days or fewer at a time.` };
  }
  return { ok: true, timeMin: min.toISOString(), timeMax: max.toISOString() };
}
