import { zonedInstant } from '@truefoundry/trueforge-core/core/calendar/timeRange';
import { FALLBACK_TIMEZONE, isValidTimezone } from '@truefoundry/trueforge-core/core/util/clientTimezone';

/** Words that make a message look like a bill or a deadline, so the rest of it is worth reading. */
const BILL_WORDS =
  /\b(invoice|bill|amount due|balance due|payment due|statement|pay(?:ment)? by|due (?:on|by|date)|deadline|expires?|renewal|overdue|past due|final notice)\b/i;

/** Words that say a bill has been settled. */
const PAID_WORDS =
  /\b(paid in full|has been paid|was paid|payment (?:was )?(?:received|confirmed|successful|processed)|thank you for your payment|receipt for your payment|autopay (?:payment )?(?:was )?(?:made|processed))\b/i;

/** Whether the start of a message looks like it names a bill or deadline. */
export function looksLikeBill(text: string): boolean {
  return BILL_WORDS.test(text);
}

/** Whether a later message says the bill was paid. */
export function saysPaid(text: string): boolean {
  return PAID_WORDS.test(text);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const CUE = /\b(due|by|before|deadline|expires?|until|payable|pay)\b/i;
/** How far before a date a cue word may sit and still apply to it. */
const CUE_REACH = 45;

interface Found {
  index: number;
  year: number | undefined;
  month: number;
  day: number;
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

function candidates(text: string): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    found.push({ index: m.index, year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) });
  }
  for (const m of text.matchAll(
    new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'gi'),
  )) {
    found.push({
      index: m.index,
      year: m[3] === undefined ? undefined : Number(m[3]),
      month: monthIndex(m[1] ?? ''),
      day: Number(m[2]),
    });
  }
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+(20\\d{2}))?\\b`, 'gi'),
  )) {
    found.push({
      index: m.index,
      year: m[3] === undefined ? undefined : Number(m[3]),
      month: monthIndex(m[2] ?? ''),
      day: Number(m[1]),
    });
  }
  return found.filter(item => item.month >= 0 && item.day >= 1 && item.day <= 31);
}

function localParts({ instant, zone }: { instant: Date; zone: string }): { year: number; month: number; day: number } {
  const [year = '1970', month = '01', day = '01'] = instant
    .toLocaleDateString('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('-');
  return { year: Number(year), month: Number(month) - 1, day: Number(day) };
}

function isoDate({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The deadline a bill or notice names: the last moment of the first date that follows a cue word such as "due" or
 * "by", read in the person's time zone. A date with no year is the next one on or after the day the message came.
 * Undefined when no date follows a cue, so a date that is only mentioned (an invoice date) never counts.
 */
export function findDeadline({
  text,
  received_at,
  timezone,
}: {
  text: string;
  received_at: Date;
  timezone: string;
}): Date | undefined {
  const zone = isValidTimezone(timezone) ? timezone : FALLBACK_TIMEZONE;
  const received = localParts({ instant: received_at, zone });
  const receivedDay = isoDate(received);
  const dates: string[] = [];
  for (const item of candidates(text)) {
    const before = text.slice(Math.max(0, item.index - CUE_REACH), item.index);
    if (!CUE.test(before)) {
      continue;
    }
    let year = item.year ?? received.year;
    if (item.year === undefined && isoDate({ year, month: item.month, day: item.day }) < receivedDay) {
      year += 1;
    }
    const date = isoDate({ year, month: item.month, day: item.day });
    if (date >= receivedDay) {
      dates.push(date);
    }
  }
  for (const m of text.matchAll(/\b(today|tomorrow)\b/gi)) {
    const before = text.slice(Math.max(0, m.index - CUE_REACH), m.index);
    if (CUE.test(before)) {
      const shifted = new Date(received_at.getTime() + (m[1]?.toLowerCase() === 'tomorrow' ? 86_400_000 : 0));
      dates.push(isoDate(localParts({ instant: shifted, zone })));
    }
  }
  const first = dates.sort()[0];
  if (first === undefined) {
    return undefined;
  }
  const instant = zonedInstant({ date: first, hour: 23, minute: 59, zone });
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}
