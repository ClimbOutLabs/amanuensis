import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { createScheduleExecutionRouter, createSchedulesRouter } from '../../../src/apis/schedules';
import { startTurnInProcess } from '../../../src/apis/turns';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { ScheduleAgentNotFoundError, startScheduleRun } from '../../../src/controller/scheduleDispatch';
import { BriefItemCompletionStore } from '../../../src/db/briefItemCompletionStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { CHAT_ASSISTANT_DESCRIPTION } from '../../../src/runtime/chatAssistant';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import {
  CreateScheduleRunResponseSchema,
  GetScheduleResponseSchema,
  ListScheduleRunsResponseSchema,
  ListSchedulesResponseSchema,
} from '../../../src/schemas/schedule';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { InMemorySentinelSettingsStore } from '../../fixtures/InMemorySentinelSettingsStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../src/controller/scheduleDispatch', () => {
  const actual = jest.requireActual<typeof import('../../../src/controller/scheduleDispatch')>(
    '../../../src/controller/scheduleDispatch',
  );
  return {
    ...actual,
    startScheduleRun: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../../../src/apis/turns', () => {
  const actual = jest.requireActual<typeof import('../../../src/apis/turns')>('../../../src/apis/turns');
  return { ...actual, startTurnInProcess: jest.fn() };
});

const mockedStartScheduleRun = startScheduleRun as jest.MockedFunction<typeof startScheduleRun>;
const mockedStartTurnInProcess = jest.mocked(startTurnInProcess);

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};
const BOB: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'bob', type: 'user', display_name: 'bob' },
  roles: [],
  user_credential: null,
};
const ADMIN: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'root', type: 'user', display_name: 'root' },
  roles: ['admin'],
  user_credential: null,
};

const scheduleBody = {
  agent_name: 'reporter',
  name: 'daily-report',
  manifest: { task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC' },
};

function stubTurnExecutionDeps(
  agentStore: SqliteAgentStore,
  scheduleStore: SqliteScheduleStore,
  db: ReturnType<typeof createSqliteDb>,
) {
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  return {
    mcpCatalog: McpCatalog.loadShipped(),
    sentinelSettingsStore: new InMemorySentinelSettingsStore(),
    scheduleStore,
    briefItemStore: new BriefItemCompletionStore(db),
    sessions: new Sessions<SessionCustom, TurnCustom>({ sessionStore }),
    agentStore,
    personaStore: { getPersona: () => Promise.resolve(undefined) },
    personalizationStore: { getProfile: () => Promise.resolve(undefined) },
    activeTurns: new ActiveTurnRegistry(),
    turnDrains: new TurnDrainRegistry(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger: winston.createLogger({ silent: true }),
    resolveModelProviderStore: () => ({}) as never,
    resolveMcpServerStore: () => ({}) as never,
    resolveSkillStore: () => ({ resolveTurnSkills: async () => [] }) as never,
    resolveSandboxProviderStore: () => ({}) as never,
    tokenStore: {} as never,
    repositoryStore: {} as never,
    sessionStore: {} as never,
    spaceStore: {} as never,
    turnArtifactStore: new FakeTurnArtifactStore(),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    tokenFactoryBudget: uncappedTokenFactoryBudget,
  };
}

async function setup(authorizer: Authorizer = new TrueForgeAuthorizer()) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const scheduleStore = new SqliteScheduleStore(db);
  await agentStore.createAgent({
    host_managed: false,
    tenant_id: 'default',
    created_by_subject: {
      subject_id: 'alice',
      subject_type: 'user',
      subject_display_name: 'alice',
    },
    name: 'reporter',
    description: 'Test agent.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: 'reporter-external-id',
  });

  let current: RequestContext = ALICE;
  let currentAuthorizer = authorizer;
  mockedStartScheduleRun.mockReset();
  mockedStartScheduleRun.mockResolvedValue(undefined);
  const app = new OpenAPIHono();
  app.route(
    '/',
    createSchedulesRouter({
      ...stubTurnExecutionDeps(agentStore, scheduleStore, db),
      resolveAgentStore: () => agentStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveRequestContext: () => current,
      authorizer: {
        listAgentAccess: input => currentAuthorizer.listAgentAccess(input),
        canAccessAgent: input => currentAuthorizer.canAccessAgent(input),
        getPermissions: input => currentAuthorizer.getPermissions(input),
      },
    }),
  );

  const asUser = (user: RequestContext) => {
    current = user;
  };
  const setAuthorizer = (next: Authorizer) => {
    currentAuthorizer = next;
  };
  const postJson = (path: string, method: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return { app, asUser, setAuthorizer, postJson, agentStore, scheduleStore };
}

describe('schedule RBAC', () => {
  it("hides another user's schedule from get, update, delete, list, and run trigger", async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    expect(created.status).toBe(201);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    asUser(BOB);
    expect((await app.request(`/${id}`)).status).toBe(403);
    expect((await postJson(`/${id}`, 'PUT', { name: 'renamed', manifest: scheduleBody.manifest })).status).toBe(403);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);

    const bobList = await app.request('/');
    expect(bobList.status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await bobList.json()).data).toEqual([]);

    expect((await app.request(`/${id}/runs`)).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });

  it('lets the creator see and manage their own schedule', async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    expect((await app.request(`/${id}`)).status).toBe(200);
    const aliceList = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await aliceList.json()).data).toHaveLength(1);
    const aliceRuns = await app.request(`/${id}/runs`);
    expect(aliceRuns.status).toBe(200);
    const aliceRunsBody = ListScheduleRunsResponseSchema.parse(await aliceRuns.json());
    expect(aliceRunsBody.data).toEqual([expect.objectContaining({ schedule_id: id })]);
    expect(aliceRunsBody.pagination.next_page_token).toBeUndefined();
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('rejects an invalid page_token when listing runs', async () => {
    const { app, asUser, postJson } = await setup();
    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;
    const res = await app.request(`/${id}/runs?page_token=not-a-token`);
    expect(res.status).toBe(400);
  });

  it('does not leak existence: a missing schedule is 404, not 403', async () => {
    const { app, asUser, postJson } = await setup();
    asUser(BOB);
    expect((await app.request('/01jqzz000000000000000nope')).status).toBe(404);
    expect((await app.request('/01jqzz000000000000000nope/runs')).status).toBe(404);
    expect((await postJson('/runs', 'POST', { schedule_id: '01jqzz000000000000000nope' })).status).toBe(404);
  });

  it("does not let an OIDC settings admin access another user's schedule", async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = ((await created.json()) as { data: { id: string } }).data;

    asUser(ADMIN);
    expect((await app.request(`/${id}`)).status).toBe(403);
    const adminList = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await adminList.json()).data).toEqual([]);
    expect((await app.request(`/${id}/runs`)).status).toBe(403);
    expect((await postJson(`/${id}`, 'PUT', { name: 'admin-renamed', manifest: scheduleBody.manifest })).status).toBe(
      403,
    );
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);
  });

  it('lets an agent manager read schedules and runs but keeps mutations creator-only', async () => {
    const { app, asUser, setAuthorizer, postJson } = await setup();
    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    setAuthorizer({
      listAgentAccess: input =>
        Promise.resolve(
          input.action === 'manage'
            ? { kind: 'agent_external_ids', agent_external_ids: ['reporter-external-id'] }
            : { kind: 'agent_external_ids', agent_external_ids: [] },
        ),
      canAccessAgent: () => Promise.resolve(false),
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    });
    asUser(BOB);
    expect((await app.request(`/${id}`)).status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await (await app.request('/')).json()).data).toHaveLength(1);
    expect(
      ListSchedulesResponseSchema.parse(await (await app.request('/?created_by_me=true')).json()).data,
    ).toHaveLength(0);
    expect(ListScheduleRunsResponseSchema.parse(await (await app.request(`/${id}/runs`)).json()).data).toHaveLength(1);
    expect((await postJson(`/${id}`, 'PUT', { name: 'renamed', manifest: scheduleBody.manifest })).status).toBe(403);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await postJson('/runs', 'POST', { schedule_id: id })).status).toBe(403);

    asUser(ALICE);
    expect(
      ListSchedulesResponseSchema.parse(await (await app.request('/?created_by_me=true')).json()).data.map(
        row => row.id,
      ),
    ).toEqual([id]);
  });
});

describe('who a schedule runs as', () => {
  it('names a saved agent by its name and a chat-made schedule by its assistant, never the stored agent name', async () => {
    const { app, asUser, postJson, agentStore, scheduleStore } = await setup();
    asUser(ALICE);
    const fromPage = await postJson('/', 'POST', scheduleBody);
    expect(GetScheduleResponseSchema.parse(await fromPage.json()).data.runs_as).toBe('reporter');

    const alice = { subject_id: 'alice', subject_type: 'user' as const, subject_display_name: 'alice' };
    const chatAgent = await agentStore.createAgent({
      host_managed: true,
      tenant_id: 'default',
      created_by_subject: alice,
      name: 'assistant-0123456789abcdef',
      description: CHAT_ASSISTANT_DESCRIPTION,
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
      external_id: null,
    });
    await scheduleStore.createScheduleAndRun({
      tenant_id: 'default',
      agent_id: chatAgent.id,
      agent_name: chatAgent.name,
      persona_id: null,
      name: 'lobster-joke',
      manifest: { task: 'Tell me a lobster joke.', cron: '0 8 * * *', timezone: 'UTC', status: 'active' },
      created_by_subject: alice,
      runFrom: new Date(),
    });

    const listed = ListSchedulesResponseSchema.parse(await (await app.request('/')).json()).data;
    const chatMade = listed.find(schedule => schedule.name === 'lobster-joke');
    expect(chatMade?.runs_as).toBe('Your assistant');
    expect(listed.map(schedule => schedule.runs_as)).not.toContain(chatAgent.name);
  });
});

describe('schedule list agent_names filter', () => {
  it('filters by a single agent_names value and by comma-separated agent_names', async () => {
    const { app, asUser, agentStore, postJson } = await setup();
    await agentStore.createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: {
        subject_id: 'alice',
        subject_type: 'user',
        subject_display_name: 'alice',
      },
      name: 'reporter-two',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: null,
    });

    asUser(ALICE);
    const aliceCreated = await postJson('/', 'POST', scheduleBody);
    const aliceId = ((await aliceCreated.json()) as { data: { id: string } }).data.id;
    const secondCreated = await postJson('/', 'POST', {
      ...scheduleBody,
      agent_name: 'reporter-two',
      name: 'daily-report-two',
    });
    const secondId = ((await secondCreated.json()) as { data: { id: string } }).data.id;

    const single = await app.request('/?agent_names=reporter');
    expect(single.status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await single.json()).data.map(row => row.id)).toEqual([aliceId]);

    const multi = await app.request('/?agent_names=reporter,reporter-two');
    expect(multi.status).toBe(200);
    expect(
      ListSchedulesResponseSchema.parse(await multi.json())
        .data.map(row => row.id)
        .sort(),
    ).toEqual([aliceId, secondId].sort());

    const withGaps = await app.request('/?agent_names=reporter,,reporter-two');
    expect(withGaps.status).toBe(200);
    expect(
      ListSchedulesResponseSchema.parse(await withGaps.json())
        .data.map(row => row.id)
        .sort(),
    ).toEqual([aliceId, secondId].sort());

    const omitted = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await omitted.json()).data).toHaveLength(2);

    // Present but empty / comma-only values fail validation.
    for (const query of ['/?agent_names=', '/?agent_names=,,,', '/?agent_names=%20,%20']) {
      const empty = await app.request(query);
      expect(empty.status).toBe(400);
    }
  });
});

describe('create schedule run', () => {
  it('creates a triggered run with a manual-* name and leaves the cron pending run alone', async () => {
    const { asUser, postJson, scheduleStore } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const pendingBefore = await scheduleStore.getScheduledRunFor({ tenant_id: 'default', schedule_id: scheduleId });
    expect(pendingBefore?.status).toBe('scheduled');

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(201);
    const body = CreateScheduleRunResponseSchema.parse(await res.json());
    expect(body.data).toEqual(
      expect.objectContaining({
        schedule_id: scheduleId,
        status: 'triggered',
        reason: null,
        created_by_subject: {
          subject_id: 'alice',
          subject_type: 'user',
          subject_display_name: 'alice',
        },
        name: expect.stringMatching(/^manual-/),
      }),
    );
    expect(body.data.triggered_at).not.toBeNull();

    expect(mockedStartScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ run: expect.objectContaining({ id: body.data.id }) }),
      }),
    );

    const pendingAfter = await scheduleStore.getScheduledRunFor({ tenant_id: 'default', schedule_id: scheduleId });
    expect(pendingAfter?.id).toBe(pendingBefore?.id);
    expect(pendingAfter?.status).toBe('scheduled');

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    expect(runs.data.map(r => r.status).sort()).toEqual(['scheduled', 'triggered']);
  });

  it('does not let an OIDC settings admin trigger another creator schedule', async () => {
    const { asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    asUser(ADMIN);
    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(403);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });

  it('marks the run failed and returns 404 when startScheduleRun reports a missing agent', async () => {
    const { asUser, postJson, scheduleStore } = await setup();
    mockedStartScheduleRun.mockRejectedValue(new ScheduleAgentNotFoundError('reporter'));

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    const runNow = runs.data.find(r => r.name.startsWith('manual-'));
    expect(runNow?.status).toBe('failed');
    expect(runNow?.reason).toBe('Agent not found: reporter');
  });

  it('returns 404 when creating a schedule for an agent the caller cannot use', async () => {
    const canAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) => Promise.resolve(false));
    const denyAll: Authorizer = {
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent,
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    };
    const { postJson } = await setup(denyAll);
    const res = await postJson('/', 'POST', scheduleBody);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');
    expect(canAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
  });

  it('returns 404 on run-now when the caller can access the schedule but not the agent', async () => {
    const { asUser, setAuthorizer, postJson, scheduleStore } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id: scheduleId } = ((await created.json()) as { data: { id: string } }).data;

    const canAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) => Promise.resolve(false));
    setAuthorizer({
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent,
      getPermissions: async ({ resourceIds }) => Object.fromEntries(resourceIds.map(id => [id, []])),
    });

    const res = await postJson('/runs', 'POST', { schedule_id: scheduleId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Agent not found: reporter');
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();

    const runs = await scheduleStore.listRuns({
      tenant_id: 'default',
      schedule_id: scheduleId,
      limit: 25,
      page_token: undefined,
    });
    expect(runs.data.some(r => r.name.startsWith('manual-'))).toBe(false);
    expect(canAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
  });
});

describe('internal schedule execution', () => {
  async function seedRun({ timezone = 'UTC' }: { timezone?: string } = {}) {
    mockedStartScheduleRun.mockReset();
    mockedStartScheduleRun.mockResolvedValue(undefined);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db);
    const alice = { subject_id: 'alice', subject_type: 'user' as const, subject_display_name: 'alice' };
    const agent = await agentStore.createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: alice,
      name: 'reporter',
      description: 'reporter description',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: 'reporter-external-id',
    });
    const { schedule } = await scheduleStore.createScheduleAndRun({
      tenant_id: 'default',
      agent_id: agent.id,
      agent_name: agent.name,
      persona_id: null,
      name: 'daily-report',
      manifest: { task: 'Say hi', cron: '0 13 * * *', timezone, status: 'active' },
      created_by_subject: alice,
      runFrom: new Date(),
    });
    const run = await scheduleStore.createRun({
      tenant_id: 'default',
      schedule_id: schedule.id,
      name: 'manual-test',
      scheduled_for: new Date(),
      status: 'triggered',
      created_by_subject: alice,
      triggered_at: new Date(),
    });
    const app = createScheduleExecutionRouter(stubTurnExecutionDeps(agentStore, scheduleStore, db));
    const execute = (scheduleRunId: string) =>
      app.request('/runs/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule_run_id: scheduleRunId }),
      });
    return { agent, run, execute };
  }

  it('executes the persisted run id', async () => {
    const { run, execute } = await seedRun();

    const response = await execute(run.id);

    expect(response.status).toBe(204);
    expect(mockedStartScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ run: expect.objectContaining({ id: run.id }) }) }),
    );
  });

  it('starts the run unattended, so it holds what would ask instead of stopping at a card', async () => {
    const { agent, run, execute } = await seedRun();
    const session = await new Sessions<SessionCustom, TurnCustom>({
      sessionStore: new InMemorySessionStore<SessionCustom, TurnCustom>(),
    }).create({
      tenant_id: 'default',
      session_id: 'run-session',
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      agent: { type: 'reference', id: agent.id, name: agent.name },
      external_id: run.id,
      source: null,
    });
    mockedStartScheduleRun.mockResolvedValue({
      session,
      input: [{ type: 'user.message', content: 'Say hi' }],
      previous_turn_id: 'none',
      userRef: 'alice',
      agent,
      persona: undefined,
    });
    mockedStartTurnInProcess.mockReset();

    const response = await execute(run.id);

    expect(response.status).toBe(204);
    expect(mockedStartTurnInProcess).toHaveBeenCalledWith(expect.objectContaining({ unattended: true }));
  });

  it("runs the turn in the schedule's own time zone, so today and times match the owner's day", async () => {
    const { agent, run, execute } = await seedRun({ timezone: 'Asia/Kolkata' });
    const session = await new Sessions<SessionCustom, TurnCustom>({
      sessionStore: new InMemorySessionStore<SessionCustom, TurnCustom>(),
    }).create({
      tenant_id: 'default',
      session_id: 'run-session-tz',
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      agent: { type: 'reference', id: agent.id, name: agent.name },
      external_id: run.id,
      source: null,
    });
    mockedStartScheduleRun.mockResolvedValue({
      session,
      input: [{ type: 'user.message', content: 'Say hi' }],
      previous_turn_id: 'none',
      userRef: 'alice',
      agent,
      persona: undefined,
    });
    mockedStartTurnInProcess.mockReset();

    const response = await execute(run.id);

    expect(response.status).toBe(204);
    expect(mockedStartTurnInProcess).toHaveBeenCalledWith(
      expect.objectContaining({ deps: expect.objectContaining({ clientTimezone: 'Asia/Kolkata' }) }),
    );
  });

  it('answers as the persona the schedule kept from its chat, like a chat turn would', async () => {
    const { agent, run, execute } = await seedRun();
    const session = await new Sessions<SessionCustom, TurnCustom>({
      sessionStore: new InMemorySessionStore<SessionCustom, TurnCustom>(),
    }).create({
      tenant_id: 'default',
      session_id: 'run-session-persona',
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      agent: { type: 'reference', id: agent.id, name: agent.name },
      external_id: run.id,
      source: null,
    });
    mockedStartScheduleRun.mockResolvedValue({
      session,
      input: [{ type: 'user.message', content: 'Say hi' }],
      previous_turn_id: 'none',
      userRef: 'alice',
      agent,
      persona: {
        tenant_id: 'default',
        id: 'persona-1',
        display_name: 'Zara',
        aliases: [],
        instructions: 'Be brief.',
        model_name: 'openai/gpt-5.2',
        created_by: 'alice',
        created_at: '2026-08-31T00:00:00.000Z',
        updated_at: '2026-08-31T00:00:00.000Z',
        updated_by: 'alice',
      },
    });
    mockedStartTurnInProcess.mockReset();

    const response = await execute(run.id);

    expect(response.status).toBe(204);
    expect(mockedStartTurnInProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({
          personaContext: expect.objectContaining({ persona_id: 'persona-1', persona_name: 'Zara' }),
        }),
      }),
    );
  });

  it('maps an unknown run to 404', async () => {
    mockedStartScheduleRun.mockReset();
    mockedStartScheduleRun.mockResolvedValue(undefined);
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db);
    const app = createScheduleExecutionRouter(stubTurnExecutionDeps(agentStore, scheduleStore, db));

    const response = await app.request('/runs/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_run_id: 'missing' }),
    });

    expect(response.status).toBe(404);
    expect(mockedStartScheduleRun).not.toHaveBeenCalled();
  });
});
