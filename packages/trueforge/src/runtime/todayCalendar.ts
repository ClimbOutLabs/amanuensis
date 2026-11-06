/**
 * The calendar half of the right rail's Home view. Reads the day's events from the connected
 * calendar accounts (Google directly, a CalDAV account through its connector) and works out
 * where the day's free time starts. Everything here is a connector read over stored state:
 * no model is called and no email is read.
 *
 * Each account's events are kept for a few minutes, so the rail's two-minute poll does not
 * reach the provider every time. Saving or removing a calendar account clears the cache at
 * once (see {@link invalidateTodayCalendarCache}), so a connector change shows on the next read.
 */
import { extractErrorLogFields, RemoteMCP } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { CalendarApi } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import type { CalendarEvent } from '@truefoundry/trueforge-core/core/calendar/calendarWire';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import { addDays, isoDay, parseDateOnly, type CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import {
  isValidTimezone,
  resolveLocalTime,
  utcOffsetMinutes,
} from '@truefoundry/trueforge-core/core/util/clientTimezone';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { IMcpServerStore } from '../db/mcpServerStore';
import type { TodayCalendarEvent } from '../schemas/today';
import { getCalendarAccountState } from './calendarAccount';

/** How long one account's events are kept before the rail reads them again. */
export const TODAY_CALENDAR_CACHE_MS = 3 * 60 * 1000;
/**
 * The oldest a cached read may be when it stands in for a provider that cannot be reached.
 * Past this, the rail would be showing another day's news under today's date, so the account
 * reads as unread instead.
 */
export const TODAY_CALENDAR_MAX_STALE_MS = 30 * 60 * 1000;

const CALDAV_TIMEOUT_MS = 15_000;
/** Most events read from one account for the two-day window. */
const EVENT_CAP = 250;

export interface TodayCalendarDeps {
  googleConnectionStore: GoogleConnectionStore | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'getServer'>;
  tenant_id: string;
  /** The calendar account agent's address and key, from configuration; unset leaves the CalDAV account unread. */
  calendarAccountUrl: string | undefined;
  calendarAccountKey: string | undefined;
  fetchImpl: typeof fetch | undefined;
  logger: Logger;
  now: () => Date;
}

/** One event with the instants the day maths needs, beside the wire shape the rail shows. */
interface DayEvent {
  /** The wire event without its day: which day it falls on is settled when the day is assembled. */
  wire: Omit<TodayCalendarEvent, 'day'>;
  start_ms: number;
  end_ms: number;
}

interface CachedAccount {
  fetched_at_ms: number;
  day_key: string;
  events: DayEvent[];
}

const cacheByAccount = new Map<string, CachedAccount>();

/** Drops every cached account read, so the next read goes back to the providers. */
export function invalidateTodayCalendarCache(): void {
  cacheByAccount.clear();
}

interface CalendarAccountRef {
  source: 'google' | 'caldav';
  account_id: string;
}

/** The instant a local day starts in `zone`: midnight as the zone counts it, DST shifts included. */
function zonedMidnight(day: CalendarDay, zone: string): Date {
  const utcMidnight = Date.UTC(day.year, day.month - 1, day.day);
  const firstOffset = utcOffsetMinutes({ instant: new Date(utcMidnight), zone });
  const first = utcMidnight - firstOffset * 60_000;
  const secondOffset = utcOffsetMinutes({ instant: new Date(first), zone });
  return new Date(utcMidnight - secondOffset * 60_000);
}

/** The instant a wall-clock time (`YYYY-MM-DDTHH:MM[:SS]`, no offset) falls in `zone`. */
function zonedWallInstant(wall: string, zone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall);
  if (match === null) {
    return null;
  }
  const utcGuess = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? '0'),
  );
  const firstOffset = utcOffsetMinutes({ instant: new Date(utcGuess), zone });
  const first = utcGuess - firstOffset * 60_000;
  const secondOffset = utcOffsetMinutes({ instant: new Date(first), zone });
  return new Date(utcGuess - secondOffset * 60_000);
}

/** The zone a read uses: the person's own when it names a real zone, else UTC. */
function zoneOf(timeZone: string | undefined): string {
  return timeZone !== undefined && isValidTimezone(timeZone) ? timeZone : 'UTC';
}

/** The instant the person's local day ends: the next local midnight in their zone. */
export function endOfLocalDay(input: { now: Date; timeZone: string | undefined }): Date {
  const zone = zoneOf(input.timeZone);
  const today =
    parseDateOnly(resolveLocalTime(input.now, zone).date) ?? parseDateOnly(input.now.toISOString().slice(0, 10));
  if (today === undefined) {
    return input.now;
  }
  return zonedMidnight(addDays({ day: today, days: 1 }), zone);
}

async function connectedAccounts(deps: TodayCalendarDeps, owner: GoogleOwner): Promise<CalendarAccountRef[]> {
  const accounts: CalendarAccountRef[] = [];
  if (deps.googleConnectionStore !== undefined) {
    const record = await deps.googleConnectionStore.get(owner);
    if (record?.status === 'connected' && grantedFeatures(record.granted_scopes).includes('calendar_read')) {
      accounts.push({ source: 'google', account_id: record.account_email ?? 'your Google account' });
    }
  }
  if (deps.calendarAccountUrl !== undefined && deps.calendarAccountKey !== undefined) {
    try {
      const accountKey = deps.calendarAccountKey;
      const state = await getCalendarAccountState({
        accountUrl: deps.calendarAccountUrl,
        secret: accountKey,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
      });
      if (state.account !== null) {
        accounts.push({ source: 'caldav', account_id: state.account.email });
      }
    } catch (error) {
      deps.logger.warn('Calendar account state could not be read for the rail', extractErrorLogFields(error));
    }
  }
  return accounts;
}

function googleDayEvent(event: CalendarEvent, account: CalendarAccountRef, zone: string): DayEvent | null {
  const start = event.start;
  if (start === undefined) {
    return null;
  }
  const title = event.summary ?? 'Untitled event';
  const location = event.location ?? null;
  if (start.date !== undefined) {
    const startDay = parseDateOnly(start.date);
    if (startDay === undefined) {
      return null;
    }
    const endDay = event.end?.date === undefined ? undefined : parseDateOnly(event.end.date);
    return {
      wire: {
        start_at: start.date,
        end_at: event.end?.date ?? null,
        title,
        location,
        all_day: true,
        source: account.source,
        calendar_account_id: account.account_id,
      },
      start_ms: zonedMidnight(startDay, zone).getTime(),
      end_ms: zonedMidnight(endDay ?? addDays({ day: startDay, days: 1 }), zone).getTime(),
    };
  }
  if (start.dateTime === undefined) {
    return null;
  }
  const startMs = Date.parse(start.dateTime);
  if (Number.isNaN(startMs)) {
    return null;
  }
  const endMs = event.end?.dateTime === undefined ? startMs : Date.parse(event.end.dateTime);
  return {
    wire: {
      start_at: new Date(startMs).toISOString(),
      end_at: Number.isNaN(endMs) ? null : new Date(endMs).toISOString(),
      title,
      location,
      all_day: false,
      source: account.source,
      calendar_account_id: account.account_id,
    },
    start_ms: startMs,
    end_ms: Number.isNaN(endMs) ? startMs : endMs,
  };
}

async function fetchGoogleEvents(
  deps: TodayCalendarDeps,
  input: { owner: GoogleOwner; account: CalendarAccountRef; window: { start: Date; end: Date }; zone: string },
): Promise<DayEvent[]> {
  const store = deps.googleConnectionStore;
  if (store === undefined) {
    return [];
  }
  const tokens = new GoogleAccessTokens({
    connections: store,
    owner: input.owner,
    now: undefined,
    fetchImpl: deps.fetchImpl,
  });
  const api = new CalendarApi({ tokens, fetchImpl: deps.fetchImpl, sleep: undefined });
  const events: DayEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await api.listEvents({
      timeMin: input.window.start.toISOString(),
      timeMax: input.window.end.toISOString(),
      query: undefined,
      maxResults: EVENT_CAP,
      pageToken,
      timeZone: input.zone,
    });
    for (const event of result.events) {
      const dayEvent = googleDayEvent(event, input.account, input.zone);
      if (dayEvent !== null) {
        events.push(dayEvent);
      }
    }
    if (result.nextPageToken === undefined || events.length >= EVENT_CAP) {
      break;
    }
    pageToken = result.nextPageToken;
  }
  return events;
}

const CaldavTimeValueSchema = z.object({
  value: z.string(),
  tzid: z.string().optional(),
  all_day: z.boolean(),
});

const CaldavListEventsResultSchema = z.object({
  structuredContent: z
    .object({
      events: z.array(
        z.looseObject({
          summary: z.string().optional(),
          location: z.string().optional(),
          start: CaldavTimeValueSchema.optional(),
          end: CaldavTimeValueSchema.optional(),
        }),
      ),
    })
    .optional(),
});

type CaldavTimeValue = z.infer<typeof CaldavTimeValueSchema>;

/** The instant a CalDAV time value names: its own offset when it carries one, else its zone, else the person's. */
function caldavInstant(time: CaldavTimeValue, personZone: string): Date | null {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(time.value)) {
    const parsed = new Date(time.value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return zonedWallInstant(time.value, time.tzid ?? personZone);
}

function caldavDayEvent(
  shaped: {
    summary?: string | undefined;
    location?: string | undefined;
    start?: CaldavTimeValue | undefined;
    end?: CaldavTimeValue | undefined;
  },
  account: CalendarAccountRef,
  zone: string,
): DayEvent | null {
  const start = shaped.start;
  if (start === undefined) {
    return null;
  }
  const title = shaped.summary ?? 'Untitled event';
  const location = shaped.location ?? null;
  if (start.all_day) {
    const startDay = parseDateOnly(start.value.slice(0, 10));
    if (startDay === undefined) {
      return null;
    }
    const endDay = shaped.end === undefined ? undefined : parseDateOnly(shaped.end.value.slice(0, 10));
    return {
      wire: {
        start_at: isoDay(startDay),
        end_at: endDay === undefined ? null : isoDay(endDay),
        title,
        location,
        all_day: true,
        source: account.source,
        calendar_account_id: account.account_id,
      },
      start_ms: zonedMidnight(startDay, zone).getTime(),
      end_ms: zonedMidnight(endDay ?? addDays({ day: startDay, days: 1 }), zone).getTime(),
    };
  }
  const startInstant = caldavInstant(start, zone);
  if (startInstant === null) {
    return null;
  }
  const endInstant = shaped.end === undefined ? null : caldavInstant(shaped.end, zone);
  return {
    wire: {
      start_at: startInstant.toISOString(),
      end_at: endInstant === null ? null : endInstant.toISOString(),
      title,
      location,
      all_day: false,
      source: account.source,
      calendar_account_id: account.account_id,
    },
    start_ms: startInstant.getTime(),
    end_ms: endInstant === null ? startInstant.getTime() : endInstant.getTime(),
  };
}

async function fetchCaldavEvents(
  deps: TodayCalendarDeps,
  input: { account: CalendarAccountRef; window: { start: Date; end: Date }; zone: string },
): Promise<DayEvent[]> {
  const record = await deps.mcpServerStore.getServer({ tenant_id: deps.tenant_id, name: CALDAV_SERVER_NAME });
  if (record?.manifest.type !== 'remote') {
    return [];
  }
  const remote = new RemoteMCP({
    name: CALDAV_SERVER_NAME,
    id: CALDAV_SERVER_NAME,
    url: record.manifest.url,
    headers: {},
    logger: deps.logger,
    requestTimeoutMs: CALDAV_TIMEOUT_MS,
    connectTimeoutMs: CALDAV_TIMEOUT_MS,
    signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS * 2),
    refuseRedirects: true,
  });
  const response = await remote.callTool({
    name: 'list_events',
    arguments: {
      from: input.window.start.toISOString(),
      to: input.window.end.toISOString(),
      timezone: input.zone,
      limit: EVENT_CAP,
    },
  });
  if (!('result' in response)) {
    return [];
  }
  const parsed = CaldavListEventsResultSchema.safeParse(response.result);
  if (!parsed.success || parsed.data.structuredContent === undefined) {
    return [];
  }
  const events: DayEvent[] = [];
  for (const shaped of parsed.data.structuredContent.events) {
    const dayEvent = caldavDayEvent(shaped, input.account, input.zone);
    if (dayEvent !== null) {
      events.push(dayEvent);
    }
  }
  return events;
}

/** One account's window of events, from the cache while it is fresh for this same local day. */
async function accountEvents(
  deps: TodayCalendarDeps,
  input: {
    owner: GoogleOwner;
    account: CalendarAccountRef;
    day_key: string;
    window: { start: Date; end: Date };
    zone: string;
  },
): Promise<DayEvent[]> {
  const key = `${input.owner.tenant_id}:${input.owner.created_by}:${input.account.source}:${input.account.account_id}:${input.zone}`;
  const cached = cacheByAccount.get(key);
  const nowMs = deps.now().getTime();
  if (cached !== undefined) {
    if (cached.day_key === input.day_key && nowMs - cached.fetched_at_ms < TODAY_CALENDAR_CACHE_MS) {
      return cached.events;
    }
  }
  let events: DayEvent[];
  try {
    events =
      input.account.source === 'google'
        ? await fetchGoogleEvents(deps, {
            owner: input.owner,
            account: input.account,
            window: input.window,
            zone: input.zone,
          })
        : await fetchCaldavEvents(deps, { account: input.account, window: input.window, zone: input.zone });
  } catch (error) {
    // A calendar that cannot be read leaves the day as the other accounts give it; the failure is logged, never hidden.
    deps.logger.warn('Calendar could not be read for the rail', extractErrorLogFields(error));
    // The last good read may stand in for a provider that is briefly unreachable, but only while
    // it is still recent: an old read served as today's would mislead, so past the bound the
    // account counts as unread, the same as having no cache at all.
    if (cached !== undefined && deps.now().getTime() - cached.fetched_at_ms < TODAY_CALENDAR_MAX_STALE_MS) {
      return cached.events;
    }
    return [];
  }
  cacheByAccount.set(key, { fetched_at_ms: nowMs, day_key: input.day_key, events });
  return events;
}

/**
 * The first time after `nowMs` with no timed event until the end of the day, or null when timed
 * events run to the day's end. All-day events mark the day but take no time in it, so they do
 * not hold free time back.
 */
export function freeAfterMs(input: { events: readonly DayEvent[]; now_ms: number; day_end_ms: number }): number | null {
  let free = input.now_ms;
  const timed = input.events
    .filter(event => !event.wire.all_day && event.start_ms < input.day_end_ms && event.end_ms > input.now_ms)
    .sort((left, right) => left.start_ms - right.start_ms);
  for (const event of timed) {
    if (event.end_ms > free) {
      free = event.end_ms;
    }
  }
  return free < input.day_end_ms ? free : null;
}

/**
 * The local day's events from every connected account, plus the next morning's first event once
 * the day is over, and the day's free-after time. `calendar` is null when no calendar
 * account is connected at all.
 */
export async function readTodayCalendar(
  deps: TodayCalendarDeps,
  input: { owner: GoogleOwner; timeZone: string | undefined },
): Promise<{ calendar: TodayCalendarEvent[] | null; free_after: string | null }> {
  const now = deps.now();
  const zone = zoneOf(input.timeZone);
  const today = parseDateOnly(resolveLocalTime(now, zone).date) ?? parseDateOnly(now.toISOString().slice(0, 10));
  if (today === undefined) {
    return { calendar: null, free_after: null };
  }
  const dayStart = zonedMidnight(today, zone);
  const dayEnd = zonedMidnight(addDays({ day: today, days: 1 }), zone);
  const windowEnd = zonedMidnight(addDays({ day: today, days: 2 }), zone);

  const accounts = await connectedAccounts(deps, input.owner);
  if (accounts.length === 0) {
    return { calendar: null, free_after: null };
  }
  const window = { start: dayStart, end: windowEnd };
  const perAccount = await Promise.all(
    accounts.map(account => accountEvents(deps, { owner: input.owner, account, day_key: isoDay(today), window, zone })),
  );
  const all = perAccount.flat();
  const nowMs = now.getTime();
  const todays = all
    .filter(event => event.start_ms < dayEnd.getTime() && event.end_ms > dayStart.getTime())
    .sort((left, right) => left.start_ms - right.start_ms || left.wire.title.localeCompare(right.wire.title));
  const shown: TodayCalendarEvent[] = todays.map(event => ({ ...event.wire, day: 'today' }));
  // The day counts as over once it has had a timed event and every timed event on it has
  // finished; only then does the rail also show what comes first tomorrow, marked as
  // tomorrow's. A day with nothing timed on it is never "over" this way, so an empty day
  // stays empty and says so, and the extra event can never pass as one of today's.
  const timed = todays.filter(event => !event.wire.all_day);
  const dayOver = timed.length > 0 && timed.every(event => event.end_ms <= nowMs);
  if (dayOver) {
    const nextMorning = all
      .filter(event => event.start_ms >= dayEnd.getTime() && event.start_ms < windowEnd.getTime())
      .sort((left, right) => left.start_ms - right.start_ms || left.wire.title.localeCompare(right.wire.title))[0];
    if (nextMorning !== undefined) {
      shown.push({ ...nextMorning.wire, day: 'tomorrow' });
    }
  }
  const free = freeAfterMs({ events: todays, now_ms: nowMs, day_end_ms: dayEnd.getTime() });
  return {
    calendar: shown,
    free_after: free === null ? null : new Date(free).toISOString(),
  };
}
