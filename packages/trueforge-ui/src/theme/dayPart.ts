export type DayPart = 'morning' | 'midday' | 'evening';

/** The local hours where the paper changes band: morning starts at 05, midday at 11, evening at 17. */
const BAND_START_HOURS = [5, 11, 17] as const;

/**
 * Picks the paper tint for a local hour: 05 to 11 morning, 11 to 17 midday,
 * 17 to 05 evening. Only the paper moves; the gold and the ink never change.
 */
export function dayPartForHour(hour: number): DayPart {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'midday';
  return 'evening';
}

/** Milliseconds from `now` until the next local band boundary; the next day's 05 closes the list, so it is never empty. */
export function msUntilNextDayPart(now: Date): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const boundaries = [
    ...BAND_START_HOURS.map(hour => new Date(year, month, day, hour)),
    new Date(year, month, day + 1, BAND_START_HOURS[0]),
  ];
  return Math.min(...boundaries.map(boundary => boundary.getTime() - now.getTime()).filter(ms => ms > 0));
}
