import type { ReminderItem } from './types.js';

export type ReminderGroups = {
  /** Still to come, paused ones included, soonest first. */
  comingUp: ReminderItem[];
  /** Times that have passed, newest first. */
  alreadyReminded: ReminderItem[];
};

function timeOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Soonest first; a reminder with no due time goes last, and equal times keep the order they were set in. */
function bySoonest(a: ReminderItem, b: ReminderItem): number {
  const aTime = timeOf(a.nextDueAt);
  const bTime = timeOf(b.nextDueAt);
  if (aTime === null && bTime === null) return (timeOf(a.setAt) ?? 0) - (timeOf(b.setAt) ?? 0);
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return aTime - bTime;
}

function lastTimeOf(item: ReminderItem): number | null {
  return timeOf(item.lastRemindedAt) ?? timeOf(item.lastDueAt);
}

/** Newest first, by when it last reached the person, or when it was due if it never did. */
function byNewest(a: ReminderItem, b: ReminderItem): number {
  const aTime = lastTimeOf(a);
  const bTime = lastTimeOf(b);
  if (aTime === null && bTime === null) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return bTime - aTime;
}

/**
 * Splits reminders into the two groups the view shows. A reminder whose time has not been and gone
 * stays in Coming up, including one due at this very moment; only a firing that already happened,
 * or failed to happen, puts it in Already reminded.
 */
export function groupReminders(reminders: readonly ReminderItem[]): ReminderGroups {
  const comingUp: ReminderItem[] = [];
  const alreadyReminded: ReminderItem[] = [];
  for (const item of reminders) {
    if (item.state === 'upcoming' || item.state === 'paused') {
      comingUp.push(item);
    } else {
      alreadyReminded.push(item);
    }
  }
  comingUp.sort(bySoonest);
  alreadyReminded.sort(byNewest);
  return { comingUp, alreadyReminded };
}

function formatIn({
  iso,
  timezone,
  options,
}: {
  iso: string;
  timezone: string;
  options: Intl.DateTimeFormatOptions;
}): Intl.DateTimeFormatPart[] {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return [];
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).formatToParts(date);
  } catch {
    // A zone the browser does not know falls back to UTC rather than breaking the row.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).formatToParts(date);
  }
}

function textOf(parts: readonly Intl.DateTimeFormatPart[]): string {
  return parts.map(part => part.value).join('');
}

function partOf(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find(part => part.type === type)?.value ?? '';
}

/** "Wednesday at 9:00 AM", read in the reminder's own time zone. The date itself is on the row's day tile. */
export function formatReminderWhen(iso: string, timezone: string): string {
  const parts = formatIn({ iso, timezone, options: { weekday: 'long', hour: 'numeric', minute: '2-digit' } });
  if (parts.length === 0) return '';
  const time = `${partOf(parts, 'hour')}:${partOf(parts, 'minute')} ${partOf(parts, 'dayPeriod')}`;
  return `${partOf(parts, 'weekday')} at ${time}`;
}

/** "Nov 1, 2026", read in the reminder's own time zone. */
export function formatReminderDay(iso: string, timezone: string): string {
  return textOf(formatIn({ iso, timezone, options: { month: 'short', day: 'numeric', year: 'numeric' } }));
}

/** The time a row is about: when it is next due, or when it last fired or was due. Null when nothing is queued. */
export function reminderMoment(item: ReminderItem): string | null {
  switch (item.state) {
    case 'upcoming':
      return item.nextDueAt;
    case 'paused':
      return null;
    case 'reminded':
      return item.lastRemindedAt ?? item.lastDueAt;
    case 'missed':
      return item.lastDueAt;
  }
}

/** The month and day a row's tile shows, read in the reminder's own time zone. Null for a time that cannot be read. */
export function reminderDayTile(iso: string, timezone: string): { month: string; day: string } | null {
  const parts = formatIn({ iso, timezone, options: { month: 'short', day: 'numeric' } });
  const month = partOf(parts, 'month');
  const day = partOf(parts, 'day');
  return month === '' || day === '' ? null : { month, day };
}

/** Days since a fixed day for the calendar date an instant falls on in a time zone. */
function calendarDay(iso: string, timezone: string): number {
  const parts = formatIn({ iso, timezone, options: { year: 'numeric', month: 'numeric', day: 'numeric' } });
  const utc = Date.UTC(Number(partOf(parts, 'year')), Number(partOf(parts, 'month')) - 1, Number(partOf(parts, 'day')));
  return Math.round(utc / 86_400_000);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How far off a time is, at a glance: "In 3 weeks", "Tomorrow", "2 hours ago". Within a day it counts
 * minutes and hours; beyond that it counts calendar days in the reminder's own time zone, so a reminder
 * for tomorrow morning says "Tomorrow" even when it is more than 24 hours away.
 */
export function reminderRelativeWords({ iso, timezone, now }: { iso: string; timezone: string; now: Date }): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = then - now.getTime();
  const size = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;
  const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  let words: string;
  if (size < MINUTE_MS) {
    words = 'now';
  } else if (size < HOUR_MS) {
    words = relative.format(sign * Math.round(size / MINUTE_MS), 'minute');
  } else if (size < DAY_MS) {
    words = relative.format(sign * Math.round(size / HOUR_MS), 'hour');
  } else {
    const days = calendarDay(iso, timezone) - calendarDay(now.toISOString(), timezone);
    const count = Math.abs(days);
    if (count < 14) {
      words = relative.format(days, 'day');
    } else if (count < 60) {
      words = relative.format(Math.round(days / 7), 'week');
    } else {
      words = relative.format(Math.round(days / 30), 'month');
    }
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The when line of a row, in plain words. */
export function reminderWhenLine(item: ReminderItem): string {
  switch (item.state) {
    case 'upcoming':
      if (item.repeats || item.nextDueAt === null) return item.timing;
      return formatReminderWhen(item.nextDueAt, item.timezone);
    case 'paused':
      return item.timing;
    case 'reminded':
      return item.lastRemindedAt !== null
        ? `Reminded ${formatReminderWhen(item.lastRemindedAt, item.timezone)}`
        : item.timing;
    case 'missed':
      return item.lastDueAt !== null
        ? `Was due ${formatReminderWhen(item.lastDueAt, item.timezone)}. It did not go through.`
        : 'It did not go through.';
  }
}

/** The detail line of a row: who it was set with, and when. */
export function reminderDetailLine(item: ReminderItem): string {
  const set = `Set with ${item.personaName} on ${formatReminderDay(item.setAt, item.timezone)}`;
  if ((item.state === 'upcoming' || item.state === 'paused') && item.lastRemindedAt !== null) {
    return `${set}. Last reminded ${formatReminderDay(item.lastRemindedAt, item.timezone)}.`;
  }
  return `${set}.`;
}
