/**
 * What a calendar write will do, settled once from the call: the request Google gets, what the owner is shown,
 * and the hash that binds the two, so an approval runs only the write that was on the card.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../permissions/approvalTokens';
import { isRealDate } from '../util/calendarDay';
import { resolveLocalTime } from '../util/clientTimezone';
import type { CalendarEvent, EventTime } from './calendarWire';
import { shiftDate, zonedInstant } from './timeRange';
import { parseLocalTime, type CreateEventInput, type UpdateEventInput } from './toolContract';

/** Longest event Aman writes, so a mistyped year is caught before the card. */
const MAX_EVENT_DAYS = 366;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

export type SendUpdates = 'all' | 'none';

/** An event time as Google takes it; the kind not used is cleared, so a change can switch between the two. */
export interface EventTimeWrite {
  date: string | null;
  dateTime: string | null;
  timeZone: string | null;
}

/** The event fields a write sets. Undefined fields are not sent, so a change leaves them as they are. */
export interface EventWriteBody {
  summary: string | undefined;
  start: EventTimeWrite | undefined;
  end: EventTimeWrite | undefined;
  location: string | undefined;
  description: string | undefined;
  attendees: { email: string }[] | undefined;
}

export interface EventWriteRequest {
  /** Null for a new event. */
  event_id: string | null;
  /** The version of the event the card showed; null for a new event. */
  etag: string | null;
  body: EventWriteBody;
  send_updates: SendUpdates;
}

export interface EventTimesView {
  /** Local date and time in plain words, e.g. `Monday, October 19, 2026, 9:00 am to 10:00 am`. */
  when: string;
  /** e.g. `1 hour 30 minutes`, `All day`, `3 days`. */
  duration: string;
}

/** What the owner is shown before a write, in plain words. Text is raw; the card escapes it. */
export interface CalendarWriteReview {
  action: 'create' | 'change';
  /** The account whose main calendar is written. */
  calendar: string;
  title: string;
  when: string;
  time_zone: string;
  duration: string;
  location: string;
  description: string;
  /** Everyone invited: the new guests of a new event, the guests a change would reach. */
  attendees: string[];
  /** True when Google will email the guests about this write. */
  guests_emailed: boolean;
  /** A change to one date of a repeating event. */
  one_of_repeating: boolean;
  before: { title: string; when: string; duration: string; location: string } | null;
}

export type ResolvedEventWrite =
  { ok: true; request: EventWriteRequest; review: CalendarWriteReview } | { ok: false; error: string };

/** Hash of everything a write sends, and of the event version a change was shown against. */
export function hashEventWrite(request: EventWriteRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

/** `Monday, October 19, 2026`; a date has no zone, so it is formatted at UTC noon. */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

function clockLabel({ hour, minute }: { hour: number; minute: number }): string {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelveHour)}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function plural({ count, unit }: { count: number; unit: string }): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

function durationLabel(minutes: number): string {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / 60);
  const rest = minutes % 60;
  const parts = [
    ...(days > 0 ? [plural({ count: days, unit: 'day' })] : []),
    ...(hours > 0 ? [plural({ count: hours, unit: 'hour' })] : []),
    ...(rest > 0 ? [plural({ count: rest, unit: 'minute' })] : []),
  ];
  return parts.length === 0 ? '0 minutes' : parts.join(' ');
}

function daysBetween({ from, to }: { from: string; to: string }): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (MINUTES_PER_DAY * MS_PER_MINUTE),
  );
}

interface LocalClock {
  date: string;
  hour: number;
  minute: number;
}

function localClockAt({ instant, zone }: { instant: Date; zone: string }): LocalClock & { offset: string } {
  const local = resolveLocalTime(instant, zone);
  return {
    date: local.date,
    hour: Number(local.time.slice(0, 2)),
    minute: Number(local.time.slice(3, 5)),
    offset: local.utcOffset,
  };
}

function momentText(clock: LocalClock): string {
  return `${clock.date}T${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

type ResolvedTimes =
  { ok: true; start: EventTimeWrite; end: EventTimeWrite; view: EventTimesView } | { ok: false; error: string };

/**
 * Two dates make an all-day event whose end is its last day; two local times make a timed event read in the
 * zone. A time the clocks skip is refused rather than moved, so the card never shows a time that is not written.
 */
function resolveTimes(input: { start: string; end: string; zone: string }): ResolvedTimes {
  const { start, end, zone } = input;
  if (isRealDate(start) && isRealDate(end)) {
    const days = daysBetween({ from: start, to: end }) + 1;
    if (days < 1) {
      return { ok: false, error: 'The last day is before the first day.' };
    }
    if (days > MAX_EVENT_DAYS) {
      return { ok: false, error: `An event can last ${String(MAX_EVENT_DAYS)} days at most.` };
    }
    return {
      ok: true,
      // Google's end date is the day after the event finishes.
      start: { date: start, dateTime: null, timeZone: null },
      end: { date: shiftDate({ date: end, days: 1 }), dateTime: null, timeZone: null },
      view: {
        when: start === end ? `${dayLabel(start)}, all day` : `${dayLabel(start)} to ${dayLabel(end)}, all day`,
        duration: days === 1 ? 'All day' : plural({ count: days, unit: 'day' }),
      },
    };
  }
  const from = parseLocalTime(start);
  const to = parseLocalTime(end);
  if (from === undefined || to === undefined) {
    return { ok: false, error: 'Give start and end both as dates (all day) or both as local times.' };
  }
  const startsAt = localClockAt({ instant: zonedInstant({ ...from, zone }), zone });
  const endsAt = localClockAt({ instant: zonedInstant({ ...to, zone }), zone });
  const skipped = [
    { asked: from, got: startsAt },
    { asked: to, got: endsAt },
  ].find(pair => momentText(pair.asked) !== momentText(pair.got));
  if (skipped !== undefined) {
    return {
      ok: false,
      error: `${momentText(skipped.asked)} does not exist in ${zone} because the clocks change then. Pick another time.`,
    };
  }
  const minutes = (zonedInstant({ ...to, zone }).getTime() - zonedInstant({ ...from, zone }).getTime()) / MS_PER_MINUTE;
  if (minutes <= 0) {
    return { ok: false, error: 'The end must be after the start.' };
  }
  if (minutes > MAX_EVENT_DAYS * MINUTES_PER_DAY) {
    return { ok: false, error: `An event can last ${String(MAX_EVENT_DAYS)} days at most.` };
  }
  const dateTime = (clock: typeof startsAt) => `${momentText(clock)}:00${clock.offset}`;
  return {
    ok: true,
    start: { date: null, dateTime: dateTime(startsAt), timeZone: zone },
    end: { date: null, dateTime: dateTime(endsAt), timeZone: zone },
    view: {
      when:
        from.date === to.date
          ? `${dayLabel(from.date)}, ${clockLabel(from)} to ${clockLabel(to)}`
          : `${dayLabel(from.date)}, ${clockLabel(from)} to ${dayLabel(to.date)}, ${clockLabel(to)}`,
      duration: durationLabel(minutes),
    },
  };
}

/** An event's own start and end as the moments a call names: dates for all day, local times in the zone. */
function existingMoments(input: {
  start: EventTime | undefined;
  end: EventTime | undefined;
  zone: string;
}): { start: string; end: string } | null {
  const { start, end, zone } = input;
  if (start?.date !== undefined) {
    const lastDay = end?.date === undefined ? start.date : shiftDate({ date: end.date, days: -1 });
    return { start: start.date, end: lastDay < start.date ? start.date : lastDay };
  }
  if (start?.dateTime === undefined || Number.isNaN(Date.parse(start.dateTime))) {
    return null;
  }
  const begins = localClockAt({ instant: new Date(start.dateTime), zone });
  const ends =
    end?.dateTime === undefined || Number.isNaN(Date.parse(end.dateTime))
      ? begins
      : localClockAt({ instant: new Date(end.dateTime), zone });
  return { start: momentText(begins), end: momentText(ends) };
}

function titleOf(summary: string | undefined): string {
  return summary === undefined || summary === '' ? '(no title)' : summary;
}

export function resolveCreate(input: { call: CreateEventInput; zone: string; account: string }): ResolvedEventWrite {
  const { call, zone } = input;
  const times = resolveTimes({ start: call.start, end: call.end, zone });
  if (!times.ok) {
    return times;
  }
  const attendees = [...new Set(call.attendees ?? [])];
  const sendUpdates: SendUpdates = attendees.length === 0 ? 'none' : (call.send_updates ?? 'none');
  const location = call.location?.trim() ?? '';
  const description = call.description?.trim() ?? '';
  return {
    ok: true,
    request: {
      event_id: null,
      etag: null,
      send_updates: sendUpdates,
      body: {
        summary: call.title,
        start: times.start,
        end: times.end,
        location: location === '' ? undefined : location,
        description: description === '' ? undefined : description,
        attendees: attendees.length === 0 ? undefined : attendees.map(email => ({ email })),
      },
    },
    review: {
      action: 'create',
      calendar: input.account,
      title: call.title,
      when: times.view.when,
      time_zone: zone,
      duration: times.view.duration,
      location,
      description,
      attendees,
      guests_emailed: sendUpdates === 'all',
      one_of_repeating: false,
      before: null,
    },
  };
}

/** The new start and end of a change: a start alone keeps the length, an end alone keeps the start. */
function changedMoments(input: {
  call: UpdateEventInput;
  existing: { start: string; end: string };
  zone: string;
}): { start: string; end: string } | { error: string } {
  const { call, existing, zone } = input;
  const start = call.start ?? existing.start;
  if (call.end !== undefined) {
    return { start, end: call.end };
  }
  const wasAllDay = isRealDate(existing.start);
  if (wasAllDay !== isRealDate(start)) {
    return { error: 'To switch between all day and a set time, give both start and end.' };
  }
  if (wasAllDay) {
    return { start, end: shiftDate({ date: start, days: daysBetween({ from: existing.start, to: existing.end }) }) };
  }
  const [oldStart, oldEnd, newStart] = [existing.start, existing.end, start].map(text => parseLocalTime(text));
  if (oldStart === undefined || oldEnd === undefined || newStart === undefined) {
    return { error: 'The event times could not be read.' };
  }
  const length = zonedInstant({ ...oldEnd, zone }).getTime() - zonedInstant({ ...oldStart, zone }).getTime();
  const ends = localClockAt({ instant: new Date(zonedInstant({ ...newStart, zone }).getTime() + length), zone });
  return { start, end: momentText(ends) };
}

/**
 * A change to an event the owner organizes, against the version just read. Guests already on the event are
 * listed, and a change that would reach them needs an explicit choice about the email.
 */
export function resolveUpdate(input: {
  call: UpdateEventInput;
  zone: string;
  account: string;
  existing: CalendarEvent;
}): ResolvedEventWrite {
  const { call, zone, existing } = input;
  if (existing.status === 'cancelled') {
    return { ok: false, error: 'Google Calendar has no such event.' };
  }
  if (existing.organizer?.self !== true) {
    return {
      ok: false,
      error: 'Someone else organizes this event, so Aman cannot change it. Ask the organizer to change it.',
    };
  }
  const guests = (existing.attendees ?? []).flatMap(guest =>
    guest.self === true || guest.email === undefined ? [] : [guest.email],
  );
  if (guests.length > 0 && call.send_updates === undefined) {
    return {
      ok: false,
      error: 'This event has guests. Set send_updates to "all" to email them the change, or "none" not to.',
    };
  }
  const before = existingMoments({ start: existing.start, end: existing.end, zone });
  if (before === null) {
    return { ok: false, error: 'The event times could not be read.' };
  }
  const beforeTimes = resolveTimes({ ...before, zone });
  const beforeView = beforeTimes.ok ? beforeTimes.view : { when: '(no time)', duration: '' };
  const timesChange = call.start !== undefined || call.end !== undefined;
  let times: { start: EventTimeWrite | undefined; end: EventTimeWrite | undefined; view: EventTimesView } = {
    start: undefined,
    end: undefined,
    view: beforeView,
  };
  if (timesChange) {
    const moments = changedMoments({ call, existing: before, zone });
    if ('error' in moments) {
      return { ok: false, error: moments.error };
    }
    const changed = resolveTimes({ ...moments, zone });
    if (!changed.ok) {
      return changed;
    }
    times = changed;
  }
  const sendUpdates: SendUpdates = guests.length === 0 ? 'none' : (call.send_updates ?? 'none');
  const location = call.location?.trim() ?? existing.location ?? '';
  // Only a description the change writes is shown; the one already there is left as it is.
  const description = call.description?.trim() ?? '';
  return {
    ok: true,
    request: {
      event_id: existing.id,
      etag: existing.etag ?? null,
      send_updates: sendUpdates,
      body: {
        summary: call.title,
        start: times.start,
        end: times.end,
        location: call.location?.trim(),
        description: call.description?.trim(),
        attendees: undefined,
      },
    },
    review: {
      action: 'change',
      calendar: input.account,
      title: call.title ?? titleOf(existing.summary),
      when: times.view.when,
      time_zone: zone,
      duration: times.view.duration,
      location,
      description,
      attendees: guests,
      guests_emailed: sendUpdates === 'all',
      one_of_repeating: existing.recurringEventId !== undefined,
      before: {
        title: titleOf(existing.summary),
        when: beforeView.when,
        duration: beforeView.duration,
        location: existing.location ?? '',
      },
    },
  };
}
