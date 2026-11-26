/**
 * Reading and writing a goal target's wall clock in the goal's own time zone.
 * The goal forms work in wall time: a date, and a time when the person gave
 * one. The goal stores an instant. These are the only conversions between
 * the two, so the create and edit forms always agree on what a target means.
 */

export type TargetWallParts = {
  /** The date as a form date field holds it, such as "2026-12-20". */
  date: string;
  /** The time as a form time field holds it, such as "17:00". */
  time: string;
};

type ZoneParts = { year: number; month: number; day: number; hour: number; minute: number };

function zoneParts(instant: Date, timezone: string): ZoneParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const read = (type: string): number => {
      const part = parts.find(entry => entry.type === type);
      return part === undefined ? Number.NaN : Number(part.value);
    };
    const values = {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
    };
    return Object.values(values).some(value => Number.isNaN(value)) ? null : values;
  } catch {
    return null;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The wall date and time an instant reads as in the zone, or null when the instant is not a date. */
export function targetWallParts({ iso, timezone }: { iso: string; timezone: string }): TargetWallParts | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = zoneParts(instant, timezone) ?? zoneParts(instant, 'UTC');
  if (parts === null) return null;
  return {
    date: `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
  };
}

/** How far the zone's wall clock sits ahead of UTC at an instant, in milliseconds. */
function zoneOffsetMs(timezone: string, instant: Date): number {
  const parts = zoneParts(instant, timezone);
  if (parts === null) return 0;
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const instantMinute = Math.floor(instant.getTime() / 60_000) * 60_000;
  return wallAsUtc - instantMinute;
}

/**
 * The instant a wall date and time fall at in the zone, as an ISO string. The
 * offset is read twice, so a wall time near a clock change still lands on the
 * reading the zone gives it. An unknown zone falls back to UTC.
 */
export function targetInstant({ date, time, timezone }: { date: string; time: string; timezone: string }): string {
  const [yearText, monthText, dayText] = date.split('-');
  const [hourText, minuteText] = time.split(':');
  const guess = Date.UTC(
    Number(yearText ?? '1970'),
    Number(monthText ?? '1') - 1,
    Number(dayText ?? '1'),
    Number(hourText ?? '0'),
    Number(minuteText ?? '0'),
  );
  const zone = zoneParts(new Date(guess), timezone) === null ? 'UTC' : timezone;
  const first = guess - zoneOffsetMs(zone, new Date(guess));
  const corrected = guess - zoneOffsetMs(zone, new Date(first));
  return new Date(corrected).toISOString();
}
