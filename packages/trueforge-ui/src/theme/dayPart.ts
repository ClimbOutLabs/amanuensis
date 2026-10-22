export type DayPart = 'morning' | 'midday' | 'evening';

/**
 * Picks the paper tint for a local hour: 05 to 11 morning, 11 to 17 midday,
 * 17 to 05 evening. Only the paper moves; the gold and the ink never change.
 */
export function dayPartForHour(hour: number): DayPart {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'midday';
  return 'evening';
}
