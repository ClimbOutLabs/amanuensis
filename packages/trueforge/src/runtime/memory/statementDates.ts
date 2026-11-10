/** How long after its end date a statement is still shown, as "Earlier". */
const RECENTLY_ENDED_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// English only for now: a message in another language does not count as asking about the past.
const PAST_CUES =
  /\b(?:before|used to|original|originally|first|previous|previously|former|formerly|earlier|still|no longer|anymore|back then)\b/i;

/** Whether the message asks about how things were, so statements that ended long ago may be shown. */
export function asksAboutPast(message: string): boolean {
  return PAST_CUES.test(message);
}

/** The last calendar day a fact date stands for: `2026` is 2026-12-31 and `2026-03` is 2026-03-31. */
export function lastDayOf(date: string): string {
  const [year = '', month, day] = date.split('-');
  if (day !== undefined) {
    return date;
  }
  const lastOfMonth = new Date(Date.UTC(Number(year), month === undefined ? 12 : Number(month), 0));
  return lastOfMonth.toISOString().slice(0, 10);
}

/** Whether an `until` date is before today. Dates are `YYYY-MM-DD` days; plain strings compare in day order. */
export function endedBefore({ until, today }: { until: string; today: string }): boolean {
  return lastDayOf(until) < today;
}

/** Whole days from the last day `until` stands for to today; negative while it has not passed. */
export function daysSinceEnd({ until, today }: { until: string; today: string }): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDayOf(until)}T00:00:00Z`)) / DAY_MS);
}

/** Whether a statement that ended on `until` is recent enough to show without being asked about. */
export function endedRecently({ until, today }: { until: string; today: string }): boolean {
  return daysSinceEnd({ until, today }) <= RECENTLY_ENDED_DAYS;
}
