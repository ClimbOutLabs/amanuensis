/** Turns the days and moments a caller names into the instants Google wants, reading a bare date in the user's time zone. */
import { MAX_RANGE_DAYS } from './toolContract';

const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(moment: string): boolean {
  return DATE_ONLY.test(moment);
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes({ instant, zone }: { instant: Date; zone: string }): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(candidate => candidate.type === type)?.value ?? '0');
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

/** The instant a calendar day begins in the zone. Checked twice, so a day that starts across a clock change is right. */
function startOfDay({ date, zone }: { date: string; zone: string }): Date {
  const [year, month, day] = date.split('-').map(Number);
  const wallClock = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const first = wallClock - offsetMinutes({ instant: new Date(wallClock), zone }) * 60_000;
  const second = wallClock - offsetMinutes({ instant: new Date(first), zone }) * 60_000;
  return new Date(second);
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10);
}

export type Bounds = { ok: true; timeMin: string; timeMax: string } | { ok: false; error: string };

/** A start date begins that day and an end date includes it whole; a moment with an offset is used as it is. */
export function resolveBounds(input: { time_min: string; time_max: string; zone: string }): Bounds {
  const min = isDateOnly(input.time_min)
    ? startOfDay({ date: input.time_min, zone: input.zone })
    : new Date(input.time_min);
  const max = isDateOnly(input.time_max)
    ? startOfDay({ date: nextDay(input.time_max), zone: input.zone })
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

/** The calendar day before a date, for an all-day event whose end date is the day after it finishes. */
export function previousDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - 1)).toISOString().slice(0, 10);
}

export function weekdayOfDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`));
}
