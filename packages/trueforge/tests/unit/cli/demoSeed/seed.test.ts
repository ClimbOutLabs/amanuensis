import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { MORNING_BRIEF_SCHEDULE_NAME } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { defaultSearchConnector } from '../../../../src/catalog/defaultSearchConnector';
import { SkillCatalog } from '../../../../src/catalog/SkillCatalog';
import { resetDemoWorld, seedDemoWorld } from '../../../../src/cli/demoSeed/seed';
import { dayInZone, parseDemoDay } from '../../../../src/cli/demoSeed/storyDays.mjs';
import {
  buildDemoWorld,
  DEMO_AGENT_NAME,
  DEMO_JUNE_ID,
  DEMO_MARKER,
  DEMO_TASKS_SPACE_ID,
  DEMO_THEO_ID,
  DEMO_USER_PROFILE,
} from '../../../../src/cli/demoSeed/world';
import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import {
  createTestWorld,
  MAIL_MCP_URL,
  MODEL_NAME,
  TENANT_ID,
  testConnectors,
  USER_ID,
  type TestStores,
  type TestWorld,
} from './testStores';

const scope = { tenantId: TENANT_ID, userId: USER_ID };
const owner = { tenant_id: TENANT_ID, created_by: USER_ID };
const DAY_ONE = new Date('2026-10-26T08:00:00Z');
const DAY_TWO = new Date('2026-11-02T08:00:00Z');
const NOTE_COUNT = buildDemoWorld({
  today: { year: 2026, month: 10, day: 26 },
  timeZone: 'Europe/Lisbon',
  modelName: MODEL_NAME,
}).notes.length;

/** What earlier seeds stamped before the assistant-visible marker became a plain name. */
const LEGACY_MARKER = 'demo_synthetic';
const LEGACY_AGENT_NAME = 'demo-synthetic-assistant';
const LEGACY_SCHEDULE_NAME = 'demo-synthetic-morning-briefing';
const subject: CreatedBySubject = { subject_id: USER_ID, subject_type: 'user', subject_display_name: USER_ID };

function worldFor(now: Date) {
  const timeZone = 'Europe/Lisbon';
  return buildDemoWorld({ today: dayInZone({ now, timeZone }), timeZone, modelName: MODEL_NAME });
}

async function seed(stores: TestStores, now: Date) {
  return seedDemoWorld({ stores, scope, world: worldFor(now), now, connectors: testConnectors() });
}

async function vault(stores: TestStores) {
  const outcome = await stores.memory.listEntries({ namespace: 'default', timeoutMs: 5000 });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.entries;
}

async function spaceBody(stores: TestStores, spaceId: string): Promise<string | undefined> {
  return (await stores.spaceStore.getSpace({ ...owner, space_id: spaceId }))?.body;
}

describe('demo seed against the real stores', () => {
  let world: TestWorld;
  let stores: TestStores;

  beforeEach(async () => {
    // Only the clock is moved to the seed day (and keeps ticking): the stores stamp updated_at from it.
    jest.useFakeTimers({
      advanceTimers: true,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
      now: DAY_ONE,
    });
    world = await createTestWorld();
    stores = world.stores;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await world.teardown();
  });

  it('seeds the personas, memory, Tasks space and Morning brief schedule', async () => {
    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      personas: { [DEMO_JUNE_ID]: 'created', [DEMO_THEO_ID]: 'created' },
      profile: 'created',
      agent: 'created',
      schedule: 'created',
      spaces: { created: 1, updated: 0, unchanged: 0 },
      knowledge: { created: 11, unchanged: 0, removed: 0, still_indexing: 0 },
      memory: { created: NOTE_COUNT, updated: 0, unchanged: 0, removed: 0 },
    });

    const june = await stores.personaStore.getPersona({ ...owner, id: DEMO_JUNE_ID });
    const theo = await stores.personaStore.getPersona({ ...owner, id: DEMO_THEO_ID });
    expect([june?.display_name, theo?.display_name]).toEqual(['June', 'Theo']);
    const agent = await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: DEMO_AGENT_NAME });
    expect(agent?.manifest.config?.sandbox?.enabled).toBe(true);

    const entries = await vault(stores);
    expect(entries).toHaveLength(NOTE_COUNT);
    expect(entries.every(entry => entry.text.includes(`> ${DEMO_MARKER}:`))).toBe(true);

    const { data: schedules } = await stores.scheduleStore.listSchedules({
      tenant_id: TENANT_ID,
      limit: 10,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: undefined,
    });
    expect(schedules.map(schedule => schedule.name)).toEqual([MORNING_BRIEF_SCHEDULE_NAME]);
    expect(schedules[0]?.manifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Lisbon' });
  });

  it('saves the Tasks space the assistant can read', async () => {
    await seed(stores, DAY_ONE);

    const spaces = await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 });

    expect(spaces.map(space => space.name)).toEqual(['Tasks']);
    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('- [ ] Find English-speaking GP (in progress)');
  });

  it('keeps each persona library apart and has every document indexed', async () => {
    await seed(stores, DAY_ONE);

    const june = await stores.knowledge.listDocuments({ personaId: DEMO_JUNE_ID });
    const theo = await stores.knowledge.listDocuments({ personaId: DEMO_THEO_ID });

    expect(june.map(document => document.title)).toContain('Public transport basics');
    expect(theo.map(document => document.title)).toContain('Twelve places to shoot in Lisbon');
    expect(june.map(document => document.title)).not.toContain('Twelve places to shoot in Lisbon');
    expect([...june, ...theo].every(document => document.status === 'ready')).toBe(true);
    expect([...june, ...theo].every(document => document.source_label.startsWith(`${DEMO_MARKER}:`))).toBe(true);
    expect(world.queued).toHaveLength(11);
  });

  it('reports documents the indexer has not finished, and does not wait forever for them', async () => {
    await world.teardown();
    world = await createTestWorld({ indexes: false });
    stores = world.stores;
    const slow = {
      ...stores,
      knowledge: {
        ...stores.knowledge,
        settle: (input: { personaId: string; timeoutMs: number }) =>
          stores.knowledge.settle({ ...input, timeoutMs: 1 }),
      },
    };

    const report = await seedDemoWorld({
      stores: slow,
      scope,
      world: worldFor(DAY_ONE),
      now: DAY_ONE,
      connectors: testConnectors(),
    });

    expect(report.knowledge.still_indexing).toBe(11);
  });

  it('is idempotent: a second run on the same day changes nothing', async () => {
    await seed(stores, DAY_ONE);
    const before = {
      vault: await vault(stores),
    };

    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      personas: { [DEMO_JUNE_ID]: 'unchanged', [DEMO_THEO_ID]: 'unchanged' },
      profile: 'unchanged',
      agent: 'unchanged',
      schedule: 'unchanged',
      spaces: { created: 0, updated: 0, unchanged: 1 },
      knowledge: { created: 0, unchanged: 11, removed: 0 },
      memory: { created: 0, updated: 0, unchanged: NOTE_COUNT, removed: 0 },
    });
    expect(await vault(stores)).toEqual(before.vault);
    expect(await stores.personaStore.listPersonas(owner)).toHaveLength(2);
    expect(world.queued).toHaveLength(11);
  });

  async function rewriteTasks(body: string) {
    const tasks = await stores.spaceStore.getSpace({ ...owner, space_id: DEMO_TASKS_SPACE_ID });
    const aggregate = await stores.spaceStore.getAggregate(owner);
    await stores.spaceStore.updateSpace({
      ...owner,
      space_id: DEMO_TASKS_SPACE_ID,
      name: 'Tasks',
      purpose: tasks?.purpose ?? 'Tasks',
      status: 'active',
      format: 'markdown',
      body,
      expected_revision: tasks?.revision ?? 0,
      expected_aggregate_revision: aggregate.revision,
    });
  }

  it('replaces what the assistant wrote when the seed runs again on the same day', async () => {
    await seed(stores, DAY_ONE);
    await rewriteTasks('- [x] Pick up the lens\nEdited by the assistant.');

    const report = await seed(stores, DAY_ONE);

    expect(report.spaces).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('GP appointment Thursday, October 29, 2026');
  });

  it('re-anchors Tasks when a re-seed on the same real day uses another --today', async () => {
    await seed(stores, DAY_ONE);
    const rehearsal = buildDemoWorld({
      today: parseDemoDay('2026-12-31'),
      timeZone: 'Europe/Lisbon',
      modelName: MODEL_NAME,
    });

    const report = await seedDemoWorld({ stores, scope, world: rehearsal, now: DAY_ONE, connectors: testConnectors() });

    expect(report.spaces).toEqual({ created: 0, updated: 1, unchanged: 0 });
    const body = await spaceBody(stores, DEMO_TASKS_SPACE_ID);
    expect(body).toContain('GP appointment Monday, January 4, 2027, 09:30');
    expect(body).not.toContain('October 29');
  });

  it('rewrites the Tasks space on a new seed day, and stamps nothing into it', async () => {
    await seed(stores, DAY_ONE);
    await rewriteTasks('Edited by the assistant.');

    const report = await seed(stores, DAY_TWO);

    expect(report.spaces).toEqual({ created: 0, updated: 1, unchanged: 0 });
    const body = await spaceBody(stores, DEMO_TASKS_SPACE_ID);
    expect(body).toContain('GP appointment Thursday, November 5, 2026, 09:30');
    expect(body).not.toContain('Edited by the assistant.');
    expect(body).not.toContain('demo_seed_day');
  });

  it('keeps a connector attached to the demo agent when it seeds again', async () => {
    await seed(stores, DAY_ONE);
    const agent = await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: DEMO_AGENT_NAME });
    await stores.agentStore.updateAgent({
      tenant_id: TENANT_ID,
      id: agent?.id ?? '',
      description: agent?.description ?? '',
      manifest: AgentSpecSchema.parse({ ...agent?.manifest, mcp_servers: [{ name: 'mail' }] }),
    });

    const again = await seed(stores, DAY_TWO);

    const stored = await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: DEMO_AGENT_NAME });
    expect(stored?.manifest.mcp_servers?.map(server => server.name)).toEqual([
      'mail',
      MAIL_CONNECTOR_NAME,
      'parallel-web',
    ]);
    expect(again.agent).toBe('updated');
  });

  it('moves only the dates that follow the day on the next seed, and keeps the rest', async () => {
    await seed(stores, DAY_ONE);

    const report = await seed(stores, DAY_TWO);

    // Only the meetup note and the Tasks space name a date that moves with the day.
    expect(report.memory).toEqual({ created: 0, updated: 1, unchanged: NOTE_COUNT - 1, removed: 0 });
    expect(report.spaces).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(report.knowledge).toMatchObject({ created: 0, unchanged: 11, removed: 0 });
    expect(await vault(stores)).toHaveLength(NOTE_COUNT);
    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('Appointment Nov 4, 10:00');
  });

  it('seeds a rehearsal day that is not the real today', async () => {
    const today = parseDemoDay('2026-10-26');
    const rehearsal = buildDemoWorld({ today, timeZone: 'Europe/Lisbon', modelName: MODEL_NAME });

    await seedDemoWorld({ stores, scope, world: rehearsal, now: DAY_TWO, connectors: testConnectors() });

    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('Appointment Oct 28, 10:00');
  });

  it('never overwrites a profile the user wrote themselves', async () => {
    await stores.personalizationStore.upsertProfile({
      tenant_id: TENANT_ID,
      created_by: USER_ID,
      updated_by: USER_ID,
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: null,
      address_as: null,
      user_profile: 'My own words.',
      pinned_preferences: [],
      help_areas: [],
      learned_profile: null,
      learning_enabled: false,
    });

    const report = await seed(stores, DAY_ONE);

    expect(report.profile).toBe('kept_existing');
    expect(
      (await stores.personalizationStore.getProfile({ tenant_id: TENANT_ID, created_by: USER_ID }))?.user_profile,
    ).toBe('My own words.');
  });

  describe('reset', () => {
    async function addRealRecords() {
      const real = { tenant_id: TENANT_ID, created_by: USER_ID };
      await stores.personaStore.createPersona({
        ...real,
        updated_by: USER_ID,
        id: 'real-persona',
        display_name: 'Marlow',
        aliases: [],
        instructions: 'A real persona.',
        model_name: MODEL_NAME,
      });
      await stores.knowledge.addTextDocument({
        personaId: 'real-persona',
        title: 'My notes',
        text: 'Mine.',
        sourceLabel: 'Pasted text',
      });
      const agent = await stores.agentStore.createAgent({
        host_managed: false,
        tenant_id: TENANT_ID,
        name: 'real-agent',
        description: 'Mine.',
        manifest: worldFor(DAY_ONE).agentSpec,
        external_id: null,
        created_by_subject: { subject_id: USER_ID, subject_type: 'user', subject_display_name: USER_ID },
      });
      await stores.withTransaction(transaction =>
        stores.scheduleStore.createScheduleAndRun(
          {
            tenant_id: TENANT_ID,
            agent_id: agent.id,
            agent_name: agent.name,
            persona_id: null,
            name: 'real-schedule',
            manifest: worldFor(DAY_ONE).scheduleManifest,
            created_by_subject: { subject_id: USER_ID, subject_type: 'user', subject_display_name: USER_ID },
            runFrom: DAY_ONE,
          },
          transaction,
        ),
      );
      await stores.spaceStore.createSpace({
        ...real,
        id: 'real-space',
        name: 'My trip',
        purpose: 'Mine.',
        status: 'active',
        format: 'markdown',
        body: 'Packing list.',
        expected_aggregate_revision: (await stores.spaceStore.getAggregate(real)).revision,
      });
      const retained = await stores.memory.retain({
        items: [{ content: 'A real note about my dog.', timestamp: DAY_ONE.toISOString(), document_id: 'real-note' }],
        operationId: 'real-op',
        timeoutMs: 5000,
      });
      expect(retained.ok).toBe(true);
    }

    /**
     * What an earlier demo seed left: its agent with a briefing schedule under an old name, a prewritten briefing
     * chat, and a persona, space, memory note and profile under the old marker.
     */
    async function plantLegacyWorld(): Promise<{ sessionId: string }> {
      const agent = await stores.agentStore.createAgent({
        host_managed: false,
        tenant_id: TENANT_ID,
        name: LEGACY_AGENT_NAME,
        description: `Synthetic demo assistant (${LEGACY_MARKER}).`,
        manifest: worldFor(DAY_ONE).agentSpec,
        external_id: null,
        created_by_subject: subject,
      });
      await stores.withTransaction(transaction =>
        stores.scheduleStore.createScheduleAndRun(
          {
            tenant_id: TENANT_ID,
            agent_id: agent.id,
            agent_name: agent.name,
            persona_id: null,
            name: LEGACY_SCHEDULE_NAME,
            manifest: worldFor(DAY_ONE).scheduleManifest,
            created_by_subject: subject,
            runFrom: DAY_ONE,
          },
          transaction,
        ),
      );
      const sessionId = 'legacy-briefing';
      await new Sessions({ sessionStore: new SqliteSessionStore(world.db) }).create({
        tenant_id: TENANT_ID,
        session_id: sessionId,
        created_by_subject: subject,
        agent: { type: 'inline', spec: worldFor(DAY_ONE).agentSpec },
        external_id: null,
        metadata: { [LEGACY_MARKER]: 'true', demo_seed_day: '2026-10-12' },
      });
      await new SentinelAuditStore(world.db).record({
        tenant_id: TENANT_ID,
        created_by: USER_ID,
        conversation_id: sessionId,
        tier: 2,
        tool_name: 'send_email',
        description: 'Send a reply',
        outcome: 'denied',
        auto_deny_reason: null,
      });
      await stores.personaStore.createPersona({
        ...owner,
        updated_by: USER_ID,
        id: 'demo-synthetic-persona-june',
        display_name: 'June',
        aliases: [],
        instructions: 'June is the life-admin assistant of Maya, a fictional demo user.',
        model_name: MODEL_NAME,
      });
      await stores.knowledge.addTextDocument({
        personaId: 'demo-synthetic-persona-june',
        title: 'Old guide',
        text: 'Old.',
        sourceLabel: `${LEGACY_MARKER}:0123456789ab`,
      });
      await stores.spaceStore.createSpace({
        ...owner,
        id: 'demo-synthetic-tasks',
        name: 'Tasks',
        purpose: 'Old tasks.',
        status: 'active',
        format: 'markdown',
        body: '- [ ] Old task',
        expected_aggregate_revision: (await stores.spaceStore.getAggregate(owner)).revision,
      });
      const retained = await stores.memory.retain({
        items: [
          {
            content: 'Maya is allergic to penicillin.',
            timestamp: DAY_ONE.toISOString(),
            context: `${LEGACY_MARKER}:health-allergy`,
            document_id: 'demo-synthetic-health-allergy',
          },
        ],
        operationId: 'legacy-op',
        timeoutMs: 5000,
      });
      expect(retained.ok).toBe(true);
      await stores.personalizationStore.upsertProfile({
        ...owner,
        updated_by: USER_ID,
        ...worldFor(DAY_ONE).profile,
        user_profile: `Maya, a fictional demo user (${LEGACY_MARKER}).`,
      });
      return { sessionId };
    }

    async function legacyLeft(sessionId: string) {
      const { data: schedules } = await stores.scheduleStore.listSchedules({
        tenant_id: TENANT_ID,
        limit: 10,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: undefined,
      });
      return {
        schedules: schedules.map(schedule => schedule.name),
        session: await new SqliteSessionStore(world.db).getSession({ tenant_id: TENANT_ID, session_id: sessionId }),
        audit: await new SentinelAuditStore(world.db).list({
          tenant_id: TENANT_ID,
          created_by: USER_ID,
          conversation_id: sessionId,
          limit: 10,
          offset: 0,
        }),
      };
    }

    it('removes what an earlier seed left, but keeps its audit rows', async () => {
      const { sessionId } = await plantLegacyWorld();

      await resetDemoWorld({ stores, scope });

      const left = await legacyLeft(sessionId);
      expect(left.schedules).toEqual([]);
      expect(left.session).toBeUndefined();
      expect(left.audit.map(row => row.tool_name)).toEqual(['send_email']);
      expect(await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: LEGACY_AGENT_NAME })).toBeUndefined();
      expect(await stores.personaStore.listPersonas(owner)).toEqual([]);
      expect(await stores.knowledge.listDocuments({ personaId: 'demo-synthetic-persona-june' })).toEqual([]);
      expect(await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 })).toEqual([]);
      expect(await vault(stores)).toEqual([]);
      expect(await stores.personalizationStore.getProfile(owner)).toBeUndefined();
    });

    it('replaces what an earlier seed left when it seeds again', async () => {
      const { sessionId } = await plantLegacyWorld();

      await seed(stores, DAY_ONE);

      const left = await legacyLeft(sessionId);
      expect(left.schedules).toEqual([MORNING_BRIEF_SCHEDULE_NAME]);
      expect(left.session).toBeUndefined();
      expect(left.audit).toHaveLength(1);
      expect(await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: LEGACY_AGENT_NAME })).toBeUndefined();
      expect((await stores.personaStore.listPersonas(owner)).map(persona => persona.id).sort()).toEqual(
        [DEMO_JUNE_ID, DEMO_THEO_ID].sort(),
      );
      expect(
        (await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 })).map(space => space.id),
      ).toEqual([DEMO_TASKS_SPACE_ID]);
      const entries = await vault(stores);
      expect(entries).toHaveLength(NOTE_COUNT);
      expect(entries.every(entry => entry.text.includes(`> ${DEMO_MARKER}:`))).toBe(true);
      expect(entries.some(entry => entry.text.includes(LEGACY_MARKER))).toBe(false);
      expect((await stores.personalizationStore.getProfile(owner))?.user_profile).toBe(DEMO_USER_PROFILE);
    });

    it('removes the synthetic records and nothing else', async () => {
      await addRealRecords();
      await seed(stores, DAY_ONE);
      const removed = await resetDemoWorld({ stores, scope });

      expect(removed).toEqual({
        personas: 2,
        profile: 1,
        agent: 1,
        schedule: 1,
        sessions: 0,
        spaces: 1,
        memory: NOTE_COUNT,
      });
      expect(await stores.personaStore.getPersona({ ...owner, id: DEMO_JUNE_ID })).toBeUndefined();
      expect(await stores.personaStore.getPersona({ ...owner, id: DEMO_THEO_ID })).toBeUndefined();
      expect(await stores.personaStore.getPersona({ ...owner, id: 'real-persona' })).toBeDefined();
      expect(await stores.knowledge.listDocuments({ personaId: 'real-persona' })).toHaveLength(1);
      expect(await stores.knowledge.listDocuments({ personaId: DEMO_JUNE_ID })).toEqual([]);
      expect(await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: DEMO_AGENT_NAME })).toBeUndefined();
      expect(await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: 'real-agent' })).toBeDefined();
      const { data: schedules } = await stores.scheduleStore.listSchedules({
        tenant_id: TENANT_ID,
        limit: 10,
        page_token: undefined,
        agent_names: undefined,
        created_by_or_agent_ids: undefined,
      });
      expect(schedules.map(schedule => schedule.name)).toEqual(['real-schedule']);
      expect(
        (await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 })).map(space => space.id),
      ).toEqual(['real-space']);
      expect((await vault(stores)).map(entry => entry.text)).toEqual([
        expect.stringContaining('A real note about my dog.'),
      ]);
      expect(
        await stores.personalizationStore.getProfile({ tenant_id: TENANT_ID, created_by: USER_ID }),
      ).toBeUndefined();
    });

    it('leaves a profile alone when it is not the synthetic one', async () => {
      await stores.personalizationStore.upsertProfile({
        tenant_id: TENANT_ID,
        created_by: USER_ID,
        updated_by: USER_ID,
        assistant_name: null,
        assistant_identity: null,
        voice_guidance: null,
        user_name: null,
        address_as: null,
        user_profile: 'My own words.',
        pinned_preferences: [],
        help_areas: [],
        learned_profile: null,
        learning_enabled: false,
      });

      const removed = await resetDemoWorld({ stores, scope });

      expect(removed.profile).toBe(0);
      expect(await stores.personalizationStore.getProfile({ tenant_id: TENANT_ID, created_by: USER_ID })).toBeDefined();
    });

    it('is a no-op on an empty instance and can seed again afterwards', async () => {
      expect(await resetDemoWorld({ stores, scope })).toEqual({
        personas: 0,
        profile: 0,
        agent: 0,
        schedule: 0,
        sessions: 0,
        spaces: 0,
        memory: 0,
      });

      await seed(stores, DAY_ONE);
      await resetDemoWorld({ stores, scope });
      const again = await seed(stores, DAY_ONE);

      expect(again.memory).toEqual({ created: NOTE_COUNT, updated: 0, unchanged: 0, removed: 0 });
      expect(again.knowledge).toMatchObject({ created: 11, unchanged: 0 });
      expect(await vault(stores)).toHaveLength(NOTE_COUNT);
    });
  });

  describe('the connectors the brief needs', () => {
    it('registers the Email connector and adds the search connector as part of the seed', async () => {
      const report = await seed(stores, DAY_ONE);

      expect(report.connectors).toEqual({ email: 'registered', search: 'added' });

      const email = await stores.mcpServerStore.getServer({ tenant_id: TENANT_ID, name: MAIL_CONNECTOR_NAME });
      expect(email).toMatchObject({
        name: MAIL_CONNECTOR_NAME,
        first_party: true,
        manifest: { type: 'remote', url: MAIL_MCP_URL },
      });

      const search = await stores.mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'parallel-web' });
      expect(search).toMatchObject({
        name: 'parallel-web',
        first_party: false,
        manifest: { type: 'remote', url: 'https://search.parallel.ai/mcp', search_provider: true },
      });
    });

    it('gives the agent the mail, calendar and search connectors the instance has, once each', async () => {
      await stores.mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: CALDAV_SERVER_NAME,
        manifest: {
          type: 'remote',
          name: CALDAV_SERVER_NAME,
          url: 'http://calendar.test/mcp',
          description: 'Calendar',
        },
        first_party: true,
      });
      await seed(stores, DAY_ONE);
      const again = await seed(stores, DAY_TWO);

      const agent = await stores.agentStore.getAgent({ tenant_id: TENANT_ID, name: DEMO_AGENT_NAME });
      expect(agent?.manifest.mcp_servers?.map(server => server.name)).toEqual([
        MAIL_CONNECTOR_NAME,
        CALDAV_SERVER_NAME,
        'parallel-web',
      ]);
      expect(again.agent).toBe('unchanged');
    });

    it('keeps both connectors ensured on a re-seed, without adding either twice', async () => {
      await seed(stores, DAY_ONE);
      const report = await seed(stores, DAY_TWO);

      expect(report.connectors).toEqual({ email: 'registered', search: 'already_offered' });
      const servers = await stores.mcpServerStore.listServers({
        tenant_id: TENANT_ID,
        names: [MAIL_CONNECTOR_NAME, 'parallel-web'],
      });
      expect(servers.map(server => server.name).sort()).toEqual([MAIL_CONNECTOR_NAME, 'parallel-web'].sort());
    });

    it('leaves email unregistered when the instance has no mail endpoint, and still adds search', async () => {
      const report = await seedDemoWorld({
        stores,
        scope,
        world: worldFor(DAY_ONE),
        now: DAY_ONE,
        connectors: { ...testConnectors(), mailUrl: undefined },
      });

      expect(report.connectors).toEqual({ email: 'unconfigured', search: 'added' });
      expect(
        await stores.mcpServerStore.getServer({ tenant_id: TENANT_ID, name: MAIL_CONNECTOR_NAME }),
      ).toBeUndefined();
      expect(await stores.mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'parallel-web' })).toBeDefined();
    });

    it('keeps a search connector the owner already chose, word for word', async () => {
      const preset = defaultSearchConnector(testConnectors().catalog);
      if (preset === undefined) {
        throw new Error('The shipped catalog has no default search connector');
      }
      await stores.mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: preset.name,
        manifest: { ...preset.manifest, description: 'Kept as the owner left it.' },
        first_party: false,
      });

      const report = await seed(stores, DAY_ONE);

      expect(report.connectors.search).toBe('kept_existing');
      const search = await stores.mcpServerStore.getServer({ tenant_id: TENANT_ID, name: preset.name });
      expect(search?.manifest).toMatchObject({ description: 'Kept as the owner left it.' });
    });
  });

  describe('the skill the demo ships', () => {
    it('enables the ten-x catalog skill as part of the seed, copied from the catalog entry', async () => {
      const entry = SkillCatalog.load()
        .list()
        .find(skill => skill.name === 'ten-x');
      if (entry === undefined) {
        throw new Error('The shipped skill catalog has no ten-x entry');
      }

      const report = await seed(stores, DAY_ONE);

      expect(report.skills).toEqual({ tenX: 'enabled' });
      const skills = await stores.skillStore.listSkills({ tenant_id: TENANT_ID, names: undefined });
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        name: 'ten-x',
        network_approval: null,
        manifest: { type: 'git', name: 'ten-x', url: entry.url, ref: entry.ref, description: entry.description },
      });
    });

    it('leaves an enabled ten-x skill as it is on a re-seed', async () => {
      await seed(stores, DAY_ONE);
      const report = await seed(stores, DAY_TWO);

      expect(report.skills).toEqual({ tenX: 'already_enabled' });
      const skills = await stores.skillStore.listSkills({ tenant_id: TENANT_ID, names: ['ten-x'] });
      expect(skills).toHaveLength(1);
    });
  });
});
