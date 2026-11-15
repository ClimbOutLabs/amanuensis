const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

interface DayParts {
  year: number;
  month: number;
  day: number;
  /** Whole days since the epoch, counted in UTC so no time zone can shift it. */
  ordinal: number;
}

function dayParts(value: string): DayParts | undefined {
  const match = DAY_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = Date.UTC(year, month - 1, day);
  // A day that does not exist, such as the 31st of a short month, rolls over and is refused.
  return new Date(instant).getUTCDate() === day ? { year, month, day, ordinal: instant / DAY_MS } : undefined;
}

function count({ amount, unit }: { amount: number; unit: string }): string {
  return `${String(amount)} ${unit}${amount === 1 ? '' : 's'} ago`;
}

/**
 * How long ago a day was, in the words a person would use: `today`, `yesterday`, then days, weeks, months and
 * years. The host works it out so a reader never has to subtract dates. Undefined for a day that cannot be
 * read or that lies after today, because nothing true can be said about its age.
 */
export function memoryAge({ day, today }: { day: string; today: string }): string | undefined {
  const then = dayParts(day);
  const now = dayParts(today);
  if (then === undefined || now === undefined || then.ordinal > now.ordinal) {
    return undefined;
  }
  const days = now.ordinal - then.ordinal;
  if (days === 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 14) {
    return count({ amount: days, unit: 'day' });
  }
  const months = (now.year - then.year) * 12 + (now.month - then.month) - (now.day < then.day ? 1 : 0);
  if (months < 2) {
    return count({ amount: Math.floor(days / 7), unit: 'week' });
  }
  if (months < 24) {
    return count({ amount: months, unit: 'month' });
  }
  return count({ amount: Math.floor(months / 12), unit: 'year' });
}
