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

function dateTimeIn(iso: string, timezone: string, withYear: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = withYear
    ? { month: 'long', day: 'numeric', year: 'numeric', timeZone: timezone }
    : { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone };
  try {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  } catch {
    // A zone the browser does not know falls back to UTC rather than breaking the row.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
  }
}

/** "Tuesday, November 4 at 9:00 AM", read in the reminder's own time zone, the way the reminder itself speaks. */
export function formatReminderWhen(iso: string, timezone: string): string {
  return dateTimeIn(iso, timezone, false);
}

/** "November 1, 2026", read in the reminder's own time zone. */
export function formatReminderDay(iso: string, timezone: string): string {
  return dateTimeIn(iso, timezone, true);
}

/** The when line of a row, in plain words. */
export function reminderWhenLine(item: ReminderItem): string {
  switch (item.state) {
    case 'upcoming':
      return item.nextDueAt !== null ? formatReminderWhen(item.nextDueAt, item.timezone) : item.timing;
    case 'paused':
      return `Paused. ${item.timing}`;
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
