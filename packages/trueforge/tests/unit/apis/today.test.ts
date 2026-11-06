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
import type { IMcpServerStore } from '../../../src/db/mcpServerStore';
import type { IScheduleStore, ScheduleRecord, ScheduleRunRecord } from '../../../src/db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { invalidateTodayCalendarCache } from '../../../src/runtime/todayCalendar';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTodayResponseSchema, type Today } from '../../../src/schemas/today';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

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

function fakeScheduleStore(): Pick<IScheduleStore, 'listSchedules' | 'getScheduledRunFor' | 'getSchedule'> {
  return {
    listSchedules: () => Promise.resolve({ data: ALL_SCHEDULES, pagination: { limit: 200 } }),
    getScheduledRunFor: input => Promise.resolve(input.schedule_id === REMINDER.id ? REMINDER_RUN : undefined),
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
function recordingFetch(calls: string[], delayMs = 0): typeof fetch {
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
      return jsonResponse(GOOGLE_EVENTS_BODY);
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
        all_day: true,
        start_at: '2026-11-06',
        source: 'google',
        calendar_account_id: 'ada@example.com',
      }),
      expect.objectContaining({
        title: 'Dentist',
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
    expect(today.carrying).toBe(2);
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
    expect(today.carrying).toBe(2);
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
  });

  it('drops the held action once it has been answered', async () => {
    await seedChat('chat-2', true);
    const router = createTodayRouter(baseDeps({ sessionStore, sessions, now: () => new Date() }));
    const response = await router.request('/');
    expect(response.status).toBe(200);
    const today = GetTodayResponseSchema.parse(await response.json()).data;
    expect(today.needs_ok).toEqual([]);
  });
});
