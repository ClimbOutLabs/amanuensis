import { OpenAPIHono } from '@hono/zod-openapi';
import { Sessions, type ISessionStore, type PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { sql, type Kysely } from 'kysely';
import { createClient } from 'redis';
import { createLogger } from 'winston';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnCreatedEvent,
  makeTurnDoneEvent,
} from '../../../../trueforge-core/tests/agent-session/testHelpers';
import { createSessionsRouter } from '../../../src/apis/sessions';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { PostgresSessionStore } from '../../../src/db/postgres/session-store/PostgresSessionStore';
import type { Database as PostgresDatabase } from '../../../src/db/postgres/types';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import {
  ListSessionEventsResponseSchema,
  MAX_EVENT_ID_LENGTH,
  SessionEventTypeSchema,
} from '../../../src/schemas/events';
import { ProfileLearnedPersistedEventSchema } from '../../../src/schemas/profileLearningEvents';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../../db/postgres/testDatabase';

type SessionStore = ISessionStore<SessionCustom, TurnCustom>;

const SESSION_ID = 'events-session';
const OTHER_SESSION_ID = 'other-session';

interface Backend {
  name: string;
  /** Fresh, empty session store plus the sqlite database the router's other stores share. */
  open: () => Promise<{
    store: SessionStore;
    ancillary: ReturnType<typeof createSqliteDb>;
    close: () => Promise<void>;
  }>;
}

async function openAncillary() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  return db;
}

let postgres: PostgresTestDatabase | undefined;

async function resetPostgres(db: Kysely<PostgresDatabase>) {
  await sql`
    TRUNCATE TABLE thread_capability_state, session_event, thread_context_log, turn_thread, turn, session
    RESTART IDENTITY CASCADE
  `.execute(db);
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    open: async () => {
      const ancillary = await openAncillary();
      return { store: new SqliteSessionStore(ancillary), ancillary, close: () => ancillary.destroy() };
    },
  },
  // Postgres runs where a server is configured (as in the store suites), and is skipped otherwise.
  ...(process.env['PG_STORE_TESTS_ADMIN_URL'] === undefined
    ? []
    : [
        {
          name: 'postgres',
          open: async () => {
            postgres ??= await createPostgresTestDatabase();
            if (postgres === undefined) {
              throw new Error('Postgres test database unavailable');
            }
            await resetPostgres(postgres.db);
            const ancillary = await openAncillary();
            return { store: new PostgresSessionStore(postgres.db), ancillary, close: () => ancillary.destroy() };
          },
        },
      ]),
];

afterAll(async () => {
  await postgres?.teardown();
});

function createApp({ store, ancillary }: { store: SessionStore; ancillary: ReturnType<typeof createSqliteDb> }) {
  const app = new OpenAPIHono();
  app.route(
    '/',
    createSessionsRouter({
      sessions: new Sessions({ sessionStore: store }),
      sessionStore: store,
      sentinelAuditStore: new SentinelAuditStore(ancillary),
      activeTurns: new ActiveTurnRegistry(),
      resolveModelProviderStore: () => new SqliteModelProviderStore(ancillary),
      resolveMcpServerStore: () => new SqliteMcpServerStore(ancillary),
      resolveSkillStore: () => new SqliteSkillStore(ancillary),
      resolveAgentStore: () => new SqliteAgentStore(ancillary),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(ancillary),
      redis: createClient(),
      requestReplyRouter: new RequestReplyRouter(),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      logger: createLogger({ silent: true }),
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  return app;
}

function profileLearned(revision: number): PersistedTurnEvent {
  return ProfileLearnedPersistedEventSchema.parse({
    type: 'aman.profile.learned',
    id: newEventId(),
    created_at: new Date().toISOString(),
    previous: null,
    current: '# Learned profile',
    revision,
  });
}

async function createSession({ store, sessionId }: { store: SessionStore; sessionId: string }) {
  await store.createSession({
    tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
    session_id: sessionId,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
}

/** t1 and t2 done, t3 still running; every turn carries one learned-profile row among its events. */
async function seedSession(store: SessionStore) {
  await createSession({ store, sessionId: SESSION_ID });
  const turnIds = ['t1', 't2', 't3'];
  for (const [index, turnId] of turnIds.entries()) {
    const previousTurnId = turnIds[index - 1];
    await store.createTurn(
      makeCreateTurnInput<TurnCustom>({
        sessionId: SESSION_ID,
        turnId,
        ...(previousTurnId === undefined ? {} : { previousTurnId, firstTurnId: 't1' }),
      }),
    );
    await store.appendToEvents({
      session_id: SESSION_ID,
      turn_id: turnId,
      events: [
        makeTurnCreatedEvent(turnId),
        makeModelMessageEvent(),
        profileLearned(index + 1),
        makeModelMessageEvent(),
      ],
    });
    if (turnId !== 't3') {
      const state = makeDoneTurnState();
      await store.updateTurnState({
        session_id: SESSION_ID,
        turn_id: turnId,
        state,
        turn_done_event: makeTurnDoneEvent(state),
      });
    }
  }
}

/** A second session with one turn of its own, whose events must never surface through `SESSION_ID`. */
async function seedOtherSession(store: SessionStore) {
  await createSession({ store, sessionId: OTHER_SESSION_ID });
  await store.createTurn(makeCreateTurnInput<TurnCustom>({ sessionId: OTHER_SESSION_ID, turnId: 'other-1' }));
  const events = [makeTurnCreatedEvent('other-1'), profileLearned(9)];
  await store.appendToEvents({ session_id: OTHER_SESSION_ID, turn_id: 'other-1', events });
  return events;
}

type Row = { turn_id: string; type: string; id: string };

async function listPage(app: OpenAPIHono, query: string) {
  const response = await app.request(`/${SESSION_ID}/events?${query}`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    return { status: response.status, rows: [], nextPageToken: undefined };
  }
  const page = ListSessionEventsResponseSchema.parse(body);
  return {
    status: response.status,
    rows: page.data.map((item): Row => ({ turn_id: item.turn_id, type: item.event.type, id: item.event.id })),
    nextPageToken: page.pagination.next_page_token,
  };
}

/** Follows `next_page_token` to the end, running `beforeNextPage` between requests. */
async function listAll(app: OpenAPIHono, query: URLSearchParams, beforeNextPage?: () => Promise<void>) {
  const rows: Row[] = [];
  let pages = 0;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams(query);
    if (pageToken !== undefined) {
      params.set('page_token', pageToken);
    }
    const page = await listPage(app, params.toString());
    expect(page.status).toBe(200);
    rows.push(...page.rows);
    pages += 1;
    pageToken = page.nextPageToken;
    if (pageToken !== undefined) {
      await beforeNextPage?.();
    }
  } while (pageToken !== undefined);
  return { rows, pages };
}

describe.each(backends)('GET /sessions/{session_id}/events on $name', backend => {
  let store: SessionStore;
  let app: OpenAPIHono;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const opened = await backend.open();
    store = opened.store;
    close = opened.close;
    app = createApp(opened);
    await seedSession(store);
  });

  afterEach(async () => {
    await close();
  });

  it('filters by one type or by several repeated types', async () => {
    const single = await listPage(app, 'types=aman.profile.learned');
    expect(single.rows.map(row => [row.turn_id, row.type])).toEqual([
      ['t3', 'aman.profile.learned'],
      ['t2', 'aman.profile.learned'],
      ['t1', 'aman.profile.learned'],
    ]);

    const several = await listPage(app, 'types=turn.done&types=aman.profile.learned');
    expect(several.rows.map(row => [row.turn_id, row.type])).toEqual([
      ['t3', 'aman.profile.learned'],
      ['t2', 'turn.done'],
      ['t2', 'aman.profile.learned'],
      ['t1', 'turn.done'],
      ['t1', 'aman.profile.learned'],
    ]);
  });

  it('rejects an unknown event type and an empty cursor', async () => {
    expect((await listPage(app, 'types=not.an.event')).status).toBe(400);
    expect((await listPage(app, 'after_event_id=')).status).toBe(400);
  });

  it('returns only events newer than after_event_id', async () => {
    const all = await listAll(app, new URLSearchParams());
    const cursor = all.rows.filter(row => row.turn_id === 't2').at(-1)?.id ?? '';
    expect(cursor).not.toBe('');

    const newer = await listAll(app, new URLSearchParams({ after_event_id: cursor }));
    expect(newer.rows).toEqual(all.rows.filter(row => row.id > cursor));

    const newerProfiles = await listAll(
      app,
      new URLSearchParams([
        ['types', 'aman.profile.learned'],
        ['after_event_id', cursor],
      ]),
    );
    expect(newerProfiles.rows.map(row => row.turn_id)).toEqual(['t3', 't2']);
  });

  it('walks keyset pages without duplicates or gaps while the running turn appends', async () => {
    const snapshot = await listAll(app, new URLSearchParams());
    expect(snapshot.pages).toBe(1);

    const walked = await listAll(app, new URLSearchParams({ limit: '2' }), async () => {
      await store.appendToEvents({ session_id: SESSION_ID, turn_id: 't3', events: [makeModelMessageEvent()] });
    });
    expect(walked.pages).toBe(Math.ceil(snapshot.rows.length / 2));
    expect(walked.rows).toEqual(snapshot.rows);
  });

  it('pages a filtered listing one row at a time', async () => {
    const query = new URLSearchParams([
      ['types', 'turn.created'],
      ['types', 'aman.profile.learned'],
    ]);
    const expected = await listAll(app, query);
    query.set('limit', '1');
    const walked = await listAll(app, query);
    expect(walked.pages).toBe(expected.rows.length);
    expect(walked.rows).toEqual(expected.rows);
  });

  it('rejects a legacy offset page token', async () => {
    const legacy = Buffer.from(JSON.stringify({ last_turn_id: 't3', offset: 2 }), 'utf8').toString('base64url');
    expect((await listPage(app, `page_token=${legacy}`)).status).toBe(400);
  });

  it('bounds the types filter to one entry per type and the cursor to the event id length', async () => {
    const repeatedTypes = (count: number) =>
      new URLSearchParams(Array.from({ length: count }, (): [string, string] => ['types', 'turn.done'])).toString();
    const typeCount = SessionEventTypeSchema.options.length;
    expect((await listPage(app, repeatedTypes(typeCount))).status).toBe(200);
    expect((await listPage(app, repeatedTypes(typeCount + 1))).status).toBe(400);

    expect((await listPage(app, `after_event_id=${'0'.repeat(MAX_EVENT_ID_LENGTH)}`)).status).toBe(200);
    expect((await listPage(app, `after_event_id=${'0'.repeat(MAX_EVENT_ID_LENGTH + 1)}`)).status).toBe(400);
  });

  it("answers another session's page token with a 404 that reveals none of its events", async () => {
    await seedOtherSession(store);
    const otherPage = await app.request(`/${OTHER_SESSION_ID}/events?limit=1`);
    const otherToken = ListSessionEventsResponseSchema.parse(await otherPage.json()).pagination.next_page_token;
    expect(otherToken).toBeDefined();

    const response = await app.request(`/${SESSION_ID}/events?page_token=${otherToken ?? ''}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: 'Turn not found: other-1' } });
  });

  it("lists none of another session's events for an event id taken from it", async () => {
    const [firstOtherEvent] = await seedOtherSession(store);
    const cursor = firstOtherEvent?.id ?? '';
    expect(cursor).not.toBe('');
    // The foreign id is only a lower bound: this session's newer event comes back, the other's do not.
    const newer = makeModelMessageEvent();
    await store.appendToEvents({ session_id: SESSION_ID, turn_id: 't3', events: [newer] });

    const page = await listPage(app, `after_event_id=${cursor}`);
    expect(page.status).toBe(200);
    expect(page.rows).toEqual([{ turn_id: 't3', type: newer.type, id: newer.id }]);
  });
});
