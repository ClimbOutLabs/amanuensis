/**
 * The right rail's Home view, read from stored state. These tests prove the shape of the day
 * the endpoint returns, and the rail's one rule: reading it never reaches a model and never
 * reads email. The only network the connected-calendar case may touch is Google's own token
 * and calendar addresses, through the fake fetch below, which records every address asked for.
 */
import {
  InMemorySessionStore,
  Sessions,
  TurnCreatedEventSchema,
  type ISessionStore,
  type PersistedTurnEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { newEventId, ToolApprovalRequiredEventSchema } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { createLogger } from 'winston';

import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnCreatedEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { createTodayRouter, type TodayRouterDeps } from '../../../src/apis/today';
import type { RequestContext } from '../../../src/auth/identity';
import type { IMcpServerStore, McpServerRecord } from '../../../src/db/mcpServerStore';
import type { IScheduleStore, ScheduleRecord, ScheduleRunRecord } from '../../../src/db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { invalidateTodayCalendarCache } from '../../../src/runtime/todayCalendar';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTodayResponseSchema, type Today } from '../../../src/schemas/today';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';

const silentLogger = createLogger({ silent: true });
const TENANT = 't1';
const OWNER_ID = 'ada';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
/** A fixed morning: 9am in Los Angeles on 2026-11-06. */
const NOW = new Date('2026-11-06T17:00:00.000Z');
const ZONE_QUERY = '?client_timezone=America%2FLos_Angeles';

const REQUEST_CONTEXT: RequestContext = {
  tenant_id: TENANT,
  subject: { id: OWNER_ID, type: 'user', display_name: 'Ada' },
  roles: [],
  user_credential: null,
};

function googleRecord(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    tenant_id: TENANT,
    created_by: OWNER_ID,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'test-client-value',
    client_type: 'desktop',
    refresh_token: 'test-refresh-value',
    granted_scopes: [CALENDAR_SCOPE],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function scheduleRecord(overrides: Partial<ScheduleRecord> & Pick<ScheduleRecord, 'id' | 'manifest'>): ScheduleRecord {
  return {
    tenant_id: TENANT,
    agent_id: 'agent-1',
    agent_name: 'aman',
    name: overrides.id,
    persona_id: null,
    status: 'active',
    created_by_subject: { subject_id: OWNER_ID, subject_type: 'user', subject_display_name: 'Ada' },
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const REMINDER = scheduleRecord({
  id: 'rem-1',
  manifest: ScheduleManifestSchema.parse({
    task: 'Take the morning pills',
    cron: null,
    run_at: '2026-11-06T15:00:00.000Z',
    timezone: 'UTC',
    status: 'active',
    kind: 'reminder',
  }),
});
const TASK = scheduleRecord({
  id: 'task-1',
  manifest: ScheduleManifestSchema.parse({
    task: 'Write the weekly brief',
    cron: '0 13 * * 1',
    timezone: 'UTC',
    status: 'active',
    kind: 'task',
  }),
});
const PAUSED_TASK = scheduleRecord({
  id: 'task-2',
  status: 'paused',
  manifest: ScheduleManifestSchema.parse({
    task: 'Water the plants',
    cron: '0 9 * * 6',
    timezone: 'UTC',
    status: 'paused',
    kind: 'task',
  }),
});

const REMINDER_RUN: ScheduleRunRecord = {
  id: 'run-1',
  tenant_id: TENANT,
  schedule_id: REMINDER.id,
  name: REMINDER.name,
  scheduled_for: '2026-11-06T15:00:00.000Z',
  status: 'scheduled',
  created_by_subject: REMINDER.created_by_subject,
  triggered_at: null,
  reason: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
};

const ALL_SCHEDULES = [REMINDER, TASK, PAUSED_TASK];

function fakeScheduleStore(): Pick<IScheduleStore, 'listSchedules' | 'getScheduledRunsFor' | 'getSchedule'> {
  return {
    listSchedules: () => Promise.resolve({ data: ALL_SCHEDULES, pagination: { limit: 200 } }),
    getScheduledRunsFor: input => Promise.resolve(input.schedule_ids.includes(REMINDER.id) ? [REMINDER_RUN] : []),
    getSchedule: input => Promise.resolve(ALL_SCHEDULES.find(schedule => schedule.id === input.id)),
  };
}

function emptySessionStore(): Pick<
  ISessionStore<SessionCustom, TurnCustom>,
  'listSessions' | 'getSessionByExternalId'
> {
  return {
    listSessions: () => Promise.resolve({ data: [], pagination: { limit: 50 } }),
    getSessionByExternalId: () => Promise.resolve(undefined),
  };
}

function noSessions(): Pick<Sessions<SessionCustom, TurnCustom>, 'get'> {
  return { get: () => Promise.resolve(undefined) };
}

function noMcpServers(): Pick<IMcpServerStore, 'getServer'> {
  return { getServer: () => Promise.resolve(undefined) };
}

function baseDeps(overrides: Partial<TodayRouterDeps>): TodayRouterDeps {
  return {
    googleConnectionStore: undefined,
    mcpServerStore: noMcpServers(),
    scheduleStore: fakeScheduleStore(),
    sessionStore: emptySessionStore(),
    sessions: noSessions(),
    calendarAccountUrl: undefined,
    calendarAccountKey: undefined,
    fetchImpl: undefined,
    resolveRequestContext: () => REQUEST_CONTEXT,
    logger: silentLogger,
    now: () => NOW,
    ...overrides,
  };
}

async function readToday(router: ReturnType<typeof createTodayRouter>): Promise<Today> {
  const response = await router.request(`/${ZONE_QUERY}`);
  expect(response.status).toBe(200);
  return GetTodayResponseSchema.parse(await response.json()).data;
}

/** The day's Google answer: one timed event this morning still to come, one all-day event. */
const GOOGLE_EVENTS_BODY = {
  items: [
    {
      id: 'e1',
      summary: 'Dentist',
      location: 'The clinic on 5th',
      start: { dateTime: '2026-11-06T18:00:00Z' },
      end: { dateTime: '2026-11-06T19:00:00Z' },
    },
    {
      id: 'e2',
      summary: 'Conference day',
      start: { date: '2026-11-06' },
      end: { date: '2026-11-07' },
    },
  ],
};

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch that answers only Google's token and calendar addresses, and records every address
 * it is asked for. Any other address (a model provider, the Gmail API) is answered with a
 * failure, and the recording is what the no-model, no-email assertion reads.
 */
function recordingFetch(calls: string[], delayMs = 0, eventsBody: object = GOOGLE_EVENTS_BODY): typeof fetch {
  const impl: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
      return jsonResponse(eventsBody);
    }
    throw new Error(`Unexpected address asked for: ${url}`);
  };
  return impl;
}

describe('GET /api/v1/today', () => {
  let env: SqliteTestDatabase;
  let googleStore: SqliteGoogleConnectionStore;

  beforeEach(async () => {
    invalidateTodayCalendarCache();
    env = await createSqliteTestDatabase();
    googleStore = new SqliteGoogleConnectionStore(env.db);
  }, 120_000);

  afterEach(async () => {
    invalidateTodayCalendarCache();
    await env.teardown();
  });

  it('reads the day from the connected calendar, the reminders and the schedule count', async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls) }),
    );

    const today = await readToday(router);

    expect(today.calendar).toEqual([
      expect.objectContaining({
        title: 'Conference day',
        day: 'today',
        all_day: true,
        start_at: '2026-11-06',
        source: 'google',
        calendar_account_id: 'ada@example.com',
      }),
      expect.objectContaining({
        title: 'Dentist',
        day: 'today',
        all_day: false,
        start_at: '2026-11-06T18:00:00.000Z',
        end_at: '2026-11-06T19:00:00.000Z',
        location: 'The clinic on 5th',
      }),
    ]);
    // Free once the dentist is done; the all-day event takes no time in the day.
    expect(today.free_after).toBe('2026-11-06T19:00:00.000Z');
    expect(today.due).toEqual([
      {
        reminder_id: 'rem-1',
        title: 'Take the morning pills',
        due_at: '2026-11-06T15:00:00.000Z',
        session_id: null,
      },
    ]);
    expect(today.needs_ok).toEqual([]);
    expect(today.needs_ok_more).toBe(false);
    expect(today.as_of).toBe(NOW.toISOString());
  });

  it('never reaches a model or the email connector: only Google token and calendar addresses are asked for', async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls) }),
    );

    await readToday(router);

    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      const allowed =
        url.startsWith('https://oauth2.googleapis.com/token') ||
        url.startsWith('https://www.googleapis.com/calendar/v3/');
      expect(allowed).toBe(true);
    }
    expect(calls.some(url => url.includes('gmail'))).toBe(false);
    expect(calls.some(url => url.includes('chat/completions') || url.includes('api.openai.com'))).toBe(false);
    expect(calls.filter(url => url.includes('/calendar/v3/'))).toHaveLength(1);
  });

  it('answers from the warm cache within budget, without asking the provider again', async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls, 400) }),
    );

    await readToday(router);
    const callsAfterColdRead = calls.length;
    expect(callsAfterColdRead).toBeGreaterThan(0);

    const startedAt = Date.now();
    const today = await readToday(router);
    const elapsedMs = Date.now() - startedAt;

    expect(today.calendar).toHaveLength(2);
    expect(calls).toHaveLength(callsAfterColdRead);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('says no calendar is connected with null, not an empty list', async () => {
    const router = createTodayRouter(baseDeps({}));
    const today = await readToday(router);
    expect(today.calendar).toBeNull();
    expect(today.free_after).toBeNull();
    expect(today.due).toHaveLength(1);
  });

  it("adds tomorrow's first event, marked as tomorrow's, once the day's timed events have all finished", async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const body = {
      items: [
        // 7 to 8 in the morning, already finished by the 9am read.
        {
          id: 'e1',
          summary: 'Gym',
          start: { dateTime: '2026-11-06T15:00:00Z' },
          end: { dateTime: '2026-11-06T16:00:00Z' },
        },
        // Tomorrow at 9 in the morning.
        {
          id: 'e2',
          summary: 'Dentist',
          start: { dateTime: '2026-11-07T17:00:00Z' },
          end: { dateTime: '2026-11-07T18:00:00Z' },
        },
      ],
    };
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls, 0, body) }),
    );

    const today = await readToday(router);

    expect(today.calendar).toEqual([
      expect.objectContaining({ title: 'Gym', day: 'today' }),
      expect.objectContaining({ title: 'Dentist', day: 'tomorrow', start_at: '2026-11-07T17:00:00.000Z' }),
    ]);
  });

  it("leaves an empty day empty: tomorrow's event does not fill it or hide the empty line", async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const body = {
      items: [
        {
          id: 'e2',
          summary: 'Dentist',
          start: { dateTime: '2026-11-07T17:00:00Z' },
          end: { dateTime: '2026-11-07T18:00:00Z' },
        },
      ],
    };
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls, 0, body) }),
    );

    const today = await readToday(router);

    expect(today.calendar).toEqual([]);
  });

  it("keeps tomorrow's event out while an event today is still to come", async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const body = {
      items: [
        {
          id: 'e1',
          summary: 'Dentist',
          start: { dateTime: '2026-11-06T18:00:00Z' },
          end: { dateTime: '2026-11-06T19:00:00Z' },
        },
        {
          id: 'e2',
          summary: 'Gym',
          start: { dateTime: '2026-11-07T17:00:00Z' },
          end: { dateTime: '2026-11-07T18:00:00Z' },
        },
      ],
    };
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls, 0, body) }),
    );

    const today = await readToday(router);

    expect(today.calendar).toEqual([expect.objectContaining({ title: 'Dentist', day: 'today' })]);
  });

  it("keeps tomorrow's event out when the day holds only an all-day event", async () => {
    await googleStore.save(googleRecord());
    const calls: string[] = [];
    const body = {
      items: [
        {
          id: 'e1',
          summary: 'Conference day',
          start: { date: '2026-11-06' },
          end: { date: '2026-11-07' },
        },
        {
          id: 'e2',
          summary: 'Dentist',
          start: { dateTime: '2026-11-07T17:00:00Z' },
          end: { dateTime: '2026-11-07T18:00:00Z' },
        },
      ],
    };
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: recordingFetch(calls, 0, body) }),
    );

    const today = await readToday(router);

    expect(today.calendar).toEqual([expect.objectContaining({ title: 'Conference day', day: 'today' })]);
  });

  it('stands the last good read in for a brief outage, and stops once that read is old', async () => {
    await googleStore.save(googleRecord());
    let currentNow = NOW;
    let unreachable = false;
    const impl: typeof fetch = async input => {
      if (unreachable) {
        throw new Error('provider unreachable');
      }
      return recordingFetch([])(input);
    };
    const router = createTodayRouter(
      baseDeps({ googleConnectionStore: googleStore, fetchImpl: impl, now: () => currentNow }),
    );

    const first = await readToday(router);
    expect(first.calendar).toHaveLength(2);

    // Four minutes on, the cached read is past its fresh minutes and the provider is down:
    // the last good read stands in.
    unreachable = true;
    currentNow = new Date(NOW.getTime() + 4 * 60 * 1000);
    const duringOutage = await readToday(router);
    expect(duringOutage.calendar).toHaveLength(2);

    // Half an hour past the bound, the old read no longer stands in: the account reads as
    // unread, an empty list rather than yesterday's news under today's date.
    currentNow = new Date(NOW.getTime() + 61 * 60 * 1000);
    const afterBound = await readToday(router);
    expect(afterBound.calendar).toEqual([]);
  });
});

describe('GET /api/v1/today with a CalDAV calendar', () => {
  let inert: InertMcpServer;

  beforeEach(() => {
    invalidateTodayCalendarCache();
  });

  afterEach(async () => {
    invalidateTodayCalendarCache();
    await inert.close();
  });

  /** The account agent's address, answered by the fake fetch below; never really resolved. */
  const ACCOUNT_AGENT_URL = 'http://calendar-account.invalid';

  function caldavDeps(): Partial<TodayRouterDeps> {
    const record: McpServerRecord = {
      id: 'caldav-1',
      tenant_id: TENANT,
      name: CALDAV_SERVER_NAME,
      manifest: {
        type: 'remote',
        name: CALDAV_SERVER_NAME,
        url: inert.url,
        description: 'The calendar account connector',
      },
      first_party: false,
      created_at: '2026-10-15T00:00:00.000Z',
      updated_at: '2026-10-15T00:00:00.000Z',
    };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url === `${ACCOUNT_AGENT_URL}/account`) {
        return jsonResponse({
          connected: true,
          default: 'ada@example.org',
          accounts: [{ url: 'https://caldav.example.org/dav/', username: 'ada', email: 'ada@example.org' }],
        });
      }
      throw new Error(`Unexpected address asked for: ${url}`);
    };
    return {
      mcpServerStore: {
        getServer: input => Promise.resolve(input.name === CALDAV_SERVER_NAME ? record : undefined),
      },
      calendarAccountUrl: ACCOUNT_AGENT_URL,
      calendarAccountKey: 'test-account-key',
      fetchImpl,
    };
  }

  it("reads the day from the CalDAV account, in the person's zone", async () => {
    inert = await startInertMcpServer({
      calendar: true,
      calendarEvents: [
        {
          summary: 'School run',
          location: 'The school gate',
          start: { value: '2026-11-06T10:00:00', tzid: 'America/Los_Angeles', all_day: false },
          end: { value: '2026-11-06T10:30:00', tzid: 'America/Los_Angeles', all_day: false },
        },
        {
          summary: 'Market day',
          start: { value: '2026-11-06', all_day: true },
          end: { value: '2026-11-07', all_day: true },
        },
        {
          // No zone of its own: read in the person's zone, so noon in Los Angeles.
          summary: 'Call the bank',
          start: { value: '2026-11-06T12:00:00', all_day: false },
          end: { value: '2026-11-06T12:15:00', all_day: false },
        },
      ],
    });
    const router = createTodayRouter(baseDeps(caldavDeps()));

    const today = await readToday(router);

    expect(today.calendar).toEqual([
      expect.objectContaining({
        title: 'Market day',
        day: 'today',
        all_day: true,
        start_at: '2026-11-06',
        source: 'caldav',
        calendar_account_id: 'ada@example.org',
      }),
      expect.objectContaining({
        title: 'School run',
        day: 'today',
        all_day: false,
        start_at: '2026-11-06T18:00:00.000Z',
        end_at: '2026-11-06T18:30:00.000Z',
        location: 'The school gate',
        source: 'caldav',
      }),
      expect.objectContaining({
        title: 'Call the bank',
        day: 'today',
        start_at: '2026-11-06T20:00:00.000Z',
        end_at: '2026-11-06T20:15:00.000Z',
        source: 'caldav',
      }),
    ]);
    // Free once the last timed event ends; the all-day event takes no time in the day.
    expect(today.free_after).toBe('2026-11-06T20:15:00.000Z');

    // A second read is answered from the cache: the connector sees no new requests.
    const requestsAfterFirstRead = inert.requestsSeen();
    const again = await readToday(router);
    expect(again.calendar).toHaveLength(3);
    expect(inert.requestsSeen()).toBe(requestsAfterFirstRead);
  });

  it('reads an empty CalDAV day as an empty list, not as no calendar', async () => {
    inert = await startInertMcpServer({ calendar: true, calendarEvents: [] });
    const router = createTodayRouter(baseDeps(caldavDeps()));

    const today = await readToday(router);

    expect(today.calendar).toEqual([]);
    expect(today.free_after).toBe(NOW.toISOString());
  });
});

describe('GET /api/v1/today needs_ok', () => {
  let sessionStore: InMemorySessionStore<SessionCustom, TurnCustom>;
  let sessions: Sessions<SessionCustom, TurnCustom>;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore });
  });

  async function seedChat(sessionId: string, withAnswer: boolean): Promise<void> {
    await sessions.create({
      tenant_id: TENANT,
      session_id: sessionId,
      created_by_subject: { subject_id: OWNER_ID, subject_type: 'user', subject_display_name: 'Ada' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    await sessionStore.updateSession({
      tenant_id: TENANT,
      session_id: sessionId,
      agent: undefined,
      title: 'Trip planning',
      metadata: undefined,
    });
    await sessionStore.createTurn(makeCreateTurnInput<TurnCustom>({ sessionId, turnId: 'turn-1' }));
    const events: PersistedTurnEvent[] = [
      makeTurnCreatedEvent('turn-1'),
      ToolApprovalRequiredEventSchema.parse({
        type: 'tool.approval_required',
        id: newEventId(),
        created_at: new Date().toISOString(),
        thread_id: 'main',
        tool_calls: [
          {
            id: 'call-1',
            source_event_id: 'evt-1',
            held: true,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            tier3_card: {
              plain_what: 'Send the email to Ana',
              copy: null,
              plain_why: null,
              cannot_be_undone: null,
              why_asked_again: null,
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: null,
              outbound_text: null,
              destination_host: null,
              outbound_truncated: false,
            },
          },
        ],
      }),
    ];
    await sessionStore.appendToEvents({ session_id: sessionId, turn_id: 'turn-1', events });
    if (withAnswer) {
      const doneState = makeDoneTurnState();
      await sessionStore.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state: doneState,
        turn_done_event: makeTurnDoneEvent(doneState),
      });
      await sessionStore.createTurn(
        makeCreateTurnInput<TurnCustom>({
          sessionId,
          turnId: 'turn-2',
          previousTurnId: 'turn-1',
          firstTurnId: 'turn-1',
        }),
      );
      await sessionStore.appendToEvents({
        session_id: sessionId,
        turn_id: 'turn-2',
        events: [
          TurnCreatedEventSchema.parse({
            type: 'turn.created',
            id: newEventId(),
            created_at: new Date().toISOString(),
            turn_id: 'turn-2',
            previous_turn_id: 'turn-1',
            state: { status: 'running' },
            thread_id: null,
            input: [
              {
                type: 'user.tool_approval',
                thread_id: 'main',
                tool_call_id: 'call-1',
                approval: { status: 'allow' },
              },
            ],
          }),
        ],
      });
    }
  }

  it('lists a held action still waiting, with the chat it came from', async () => {
    await seedChat('chat-1', false);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const response = await router.request('/');
    expect(response.status).toBe(200);
    const today = GetTodayResponseSchema.parse(await response.json()).data;
    expect(today.needs_ok).toEqual([
      {
        held_action_id: 'call-1',
        title: 'Send the email to Ana',
        origin: 'Trip planning',
        session_id: 'chat-1',
      },
    ]);
    expect(today.needs_ok_more).toBe(false);
  });

  it('drops the held action once it has been answered', async () => {
    await seedChat('chat-2', true);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const response = await router.request('/');
    expect(response.status).toBe(200);
    const today = GetTodayResponseSchema.parse(await response.json()).data;
    expect(today.needs_ok).toEqual([]);
  });

  /**
   * A long chat: the same held action as seedChat, then more events of the kinds the scan
   * reads than one page holds, then (withAnswer) the turn that answers the hold.
   */
  async function seedLongChat(sessionId: string, withAnswer: boolean): Promise<void> {
    await sessions.create({
      tenant_id: TENANT,
      session_id: sessionId,
      created_by_subject: { subject_id: OWNER_ID, subject_type: 'user', subject_display_name: 'Ada' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    await sessionStore.updateSession({
      tenant_id: TENANT,
      session_id: sessionId,
      agent: undefined,
      title: 'Trip planning',
      metadata: undefined,
    });
    await sessionStore.createTurn(makeCreateTurnInput<TurnCustom>({ sessionId, turnId: 'turn-1' }));
    await sessionStore.appendToEvents({
      session_id: sessionId,
      turn_id: 'turn-1',
      events: [
        makeTurnCreatedEvent('turn-1'),
        ToolApprovalRequiredEventSchema.parse({
          type: 'tool.approval_required',
          id: newEventId(),
          created_at: new Date().toISOString(),
          thread_id: 'main',
          tool_calls: [
            {
              id: 'call-1',
              source_event_id: 'evt-1',
              held: true,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              tier3_card: {
                plain_what: 'Send the email to Ana',
                copy: null,
                plain_why: null,
                cannot_be_undone: null,
                why_asked_again: null,
                destination: null,
                recipient: null,
                amount: null,
                parsed_command: null,
                outbound_text: null,
                destination_host: null,
                outbound_truncated: false,
              },
            },
          ],
        }),
      ],
    });
    await sessionStore.appendToEvents({
      session_id: sessionId,
      turn_id: 'turn-1',
      events: Array.from({ length: 250 }, () => makeTurnCreatedEvent('turn-1')),
    });
    if (withAnswer) {
      const doneState = makeDoneTurnState();
      await sessionStore.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state: doneState,
        turn_done_event: makeTurnDoneEvent(doneState),
      });
      await sessionStore.createTurn(
        makeCreateTurnInput<TurnCustom>({
          sessionId,
          turnId: 'turn-2',
          previousTurnId: 'turn-1',
          firstTurnId: 'turn-1',
        }),
      );
      await sessionStore.appendToEvents({
        session_id: sessionId,
        turn_id: 'turn-2',
        events: [
          TurnCreatedEventSchema.parse({
            type: 'turn.created',
            id: newEventId(),
            created_at: new Date().toISOString(),
            turn_id: 'turn-2',
            previous_turn_id: 'turn-1',
            state: { status: 'running' },
            thread_id: null,
            input: [
              {
                type: 'user.tool_approval',
                thread_id: 'main',
                tool_call_id: 'call-1',
                approval: { status: 'allow' },
              },
            ],
          }),
        ],
      });
    }
  }

  it('still lists a held action buried under more than a page of newer events', async () => {
    await seedLongChat('chat-long-waiting', false);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([
      {
        held_action_id: 'call-1',
        title: 'Send the email to Ana',
        origin: 'Trip planning',
        session_id: 'chat-long-waiting',
      },
    ]);
  });

  it('drops a held action whose answer comes after more than a page of newer events', async () => {
    await seedLongChat('chat-long-answered', true);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([]);
  });

  /** One approval ref in the card's stored shape, with only the fields a case sets. */
  function approvalRef(overrides: {
    id: string;
    held?: true;
    not_saved?: 'too_many' | 'helper_agent';
    expires_at?: string;
    plain_what: string;
  }): Record<string, unknown> {
    return {
      id: overrides.id,
      source_event_id: `evt-${overrides.id}`,
      ...(overrides.held === undefined ? {} : { held: overrides.held }),
      ...(overrides.not_saved === undefined ? {} : { not_saved: overrides.not_saved }),
      ...(overrides.expires_at === undefined ? {} : { expires_at: overrides.expires_at }),
      tier3_card: {
        plain_what: overrides.plain_what,
        copy: null,
        plain_why: null,
        cannot_be_undone: null,
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
    };
  }

  /** A chat holding the given approval refs on its first turn, still unanswered. */
  async function seedApprovals(
    sessionId: string,
    refs: Record<string, unknown>[],
    options?: { source?: { type: 'schedule'; id: string; run_id: string } },
  ): Promise<void> {
    await sessions.create({
      tenant_id: TENANT,
      session_id: sessionId,
      created_by_subject: { subject_id: OWNER_ID, subject_type: 'user', subject_display_name: 'Ada' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
      ...(options?.source === undefined ? {} : { source: options.source }),
    });
    await sessionStore.createTurn(makeCreateTurnInput<TurnCustom>({ sessionId, turnId: 'turn-1' }));
    await sessionStore.appendToEvents({
      session_id: sessionId,
      turn_id: 'turn-1',
      events: [
        makeTurnCreatedEvent('turn-1'),
        ToolApprovalRequiredEventSchema.parse({
          type: 'tool.approval_required',
          id: newEventId(),
          created_at: new Date().toISOString(),
          thread_id: 'main',
          tool_calls: refs,
        }),
      ],
    });
  }

  async function readNeedsOk(router: ReturnType<typeof createTodayRouter>): Promise<Today> {
    const response = await router.request('/');
    expect(response.status).toBe(200);
    return GetTodayResponseSchema.parse(await response.json()).data;
  }

  it('drops a held action whose day to answer has passed', async () => {
    await seedApprovals('chat-expired', [
      approvalRef({
        id: 'call-old',
        held: true,
        expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
        plain_what: 'Send the email to Ana',
      }),
    ]);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([]);
    expect(today.needs_ok_more).toBe(false);
  });

  it('drops a held action that was dismissed', async () => {
    await seedApprovals('chat-dismissed', [
      approvalRef({
        id: 'call-1',
        held: true,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        plain_what: 'Send the email to Ana',
      }),
    ]);
    await sessionStore.recordApprovalDismissal({
      session_id: 'chat-dismissed',
      thread_id: 'main',
      tool_call_id: 'call-1',
      dismissed_at: new Date().toISOString(),
    });
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([]);
  });

  it('names the schedule a held action came from when its chat is a schedule run', async () => {
    await seedApprovals(
      'chat-run',
      [
        approvalRef({
          id: 'call-1',
          held: true,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          plain_what: 'Post the weekly brief',
        }),
      ],
      { source: { type: 'schedule', id: 'task-1', run_id: 'run-9' } },
    );
    const router = createTodayRouter(
      baseDeps({
        sessionStore,
        sessions,
        now: () => new Date(),
        scheduleStore: {
          ...fakeScheduleStore(),
          getSchedule: input =>
            Promise.resolve(
              input.id === 'task-1' ? { ...TASK, name: 'Weekly brief' } : ALL_SCHEDULES.find(s => s.id === input.id),
            ),
        },
      }),
    );
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([
      { held_action_id: 'call-1', title: 'Post the weekly brief', origin: 'Weekly brief', session_id: 'chat-run' },
    ]);
  });

  it('lists an approval a chat is paused on, and never one a run could not save', async () => {
    await seedApprovals('chat-paused', [
      approvalRef({ id: 'call-1', plain_what: 'Delete the old draft' }),
      approvalRef({ id: 'call-2', not_saved: 'too_many', plain_what: 'Send the email to Ana' }),
    ]);
    await sessionStore.updateSession({
      tenant_id: TENANT,
      session_id: 'chat-paused',
      agent: undefined,
      title: 'Inbox tidy',
      metadata: undefined,
    });
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toEqual([
      { held_action_id: 'call-1', title: 'Delete the old draft', origin: 'Inbox tidy', session_id: 'chat-paused' },
    ]);
  });

  it('says so when more actions are waiting than the list can show', async () => {
    const refs = Array.from({ length: 21 }, (_, index) =>
      approvalRef({
        id: `call-${String(index)}`,
        held: true,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        plain_what: `Action number ${String(index)}`,
      }),
    );
    await seedApprovals('chat-many', refs);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const today = await readNeedsOk(router);
    expect(today.needs_ok).toHaveLength(20);
    expect(today.needs_ok_more).toBe(true);
  });
});
