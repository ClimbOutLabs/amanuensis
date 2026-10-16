import { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { dayInZone, parseIsoDay } from '../../../../src/cli/demoSeed/calendar';
import { resetDemoWorld, seedDemoWorld } from '../../../../src/cli/demoSeed/seed';
import {
  buildDemoWorld,
  DEMO_AGENT_NAME,
  DEMO_JUNE_ID,
  DEMO_MARKER,
  DEMO_SCHEDULE_NAME,
  DEMO_TASKS_SPACE_ID,
  DEMO_THEO_ID,
} from '../../../../src/cli/demoSeed/world';
import { createTestWorld, MODEL_NAME, TENANT_ID, USER_ID, type TestStores, type TestWorld } from './testStores';

const scope = { tenantId: TENANT_ID, userId: USER_ID };
const owner = { tenant_id: TENANT_ID, created_by: USER_ID };
const DAY_ONE = new Date('2026-10-26T08:00:00Z');
const DAY_TWO = new Date('2026-11-02T08:00:00Z');
const NOTE_COUNT = buildDemoWorld({
  today: { year: 2026, month: 10, day: 26 },
  timeZone: 'Europe/Lisbon',
  modelName: MODEL_NAME,
}).notes.length;

function worldFor(now: Date) {
  const timeZone = 'Europe/Lisbon';
  return buildDemoWorld({ today: dayInZone({ now, timeZone }), timeZone, modelName: MODEL_NAME });
}

async function seed(stores: TestStores, now: Date) {
  return seedDemoWorld({ stores, scope, world: worldFor(now), now });
}

async function vault(stores: TestStores) {
  const outcome = await stores.memory.listEntries({ namespace: 'default', timeoutMs: 5000 });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.entries;
}

async function sessionsOf(stores: TestStores, userId: string) {
  const { data } = await stores.sessionStore.listSessions({
    tenant_id: TENANT_ID,
    limit: 100,
    page_token: undefined,
    order: undefined,
    start_timestamp: undefined,
    end_timestamp: undefined,
    agent_id: undefined,
    created_by_or_agent_ids: { created_by_subject_id: userId, agent_ids: [] },
    metadata: undefined,
    source_type: undefined,
    source_id: undefined,
  });
  return data;
}

async function spaceBody(stores: TestStores, spaceId: string): Promise<string | undefined> {
  return (await stores.spaceStore.getSpace({ ...owner, space_id: spaceId }))?.body;
}

describe('demo seed against the real stores', () => {
  let world: TestWorld;
  let stores: TestStores;

  beforeEach(async () => {
    world = await createTestWorld();
    stores = world.stores;
  });

  afterEach(async () => {
    await world.teardown();
  });

  it('seeds the personas, memory, Tasks space, Morning brief schedule and a finished route chat', async () => {
    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      personas: { [DEMO_JUNE_ID]: 'created', [DEMO_THEO_ID]: 'created' },
      profile: 'created',
      agent: 'created',
      schedule: 'created',
      briefing: 'created',
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
    expect(schedules.map(schedule => schedule.name)).toEqual([DEMO_SCHEDULE_NAME]);
    expect(schedules[0]?.manifest).toMatchObject({ cron: '30 7 * * *', timezone: 'Europe/Lisbon' });

    const [session] = await sessionsOf(stores, USER_ID);
    expect(session?.title).toBe('From Campo de Ourique to the GP');
    expect(session?.metadata).toMatchObject({ [DEMO_MARKER]: 'true', demo_seed_day: '2026-10-26' });
    const handle = await new Sessions({ sessionStore: stores.sessionStore }).get({
      tenant_id: TENANT_ID,
      session_id: session?.session_id ?? '',
    });
    const events = await handle?.listEvents({ limit: 100 });
    // Newest first.
    expect(events?.data.map(item => item.event.type).reverse()).toEqual([
      'turn.created',
      'aman.memory.recall',
      'model.message',
      'tool.response.v2',
      'model.message',
      'turn.done',
    ]);
    const turns = await handle?.listTurns({ limit: 10 });
    expect(turns?.data[0]?.state.status).toBe('done');
  });

  it('saves the Tasks space the assistant can read', async () => {
    await seed(stores, DAY_ONE);

    const spaces = await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 });

    expect(spaces.map(space => space.name)).toEqual(['Tasks']);
    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('- [ ] Find English-speaking GP');
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

    const report = await seedDemoWorld({ stores: slow, scope, world: worldFor(DAY_ONE), now: DAY_ONE });

    expect(report.knowledge.still_indexing).toBe(11);
  });

  it('recalls the GP shortlist into the pre-baked route chat from the seeded memory', async () => {
    await seed(stores, DAY_ONE);
    const [session] = await sessionsOf(stores, USER_ID);
    const handle = await new Sessions({ sessionStore: stores.sessionStore }).get({
      tenant_id: TENANT_ID,
      session_id: session?.session_id ?? '',
    });
    const events = await handle?.listEvents({ limit: 100 });
    const recall = events?.data.find(item => item.event.type === 'aman.memory.recall')?.event;
    expect(JSON.stringify(recall)).toContain('Brightwater Family Clinic');
  });

  it('is idempotent: a second run on the same day changes nothing', async () => {
    await seed(stores, DAY_ONE);
    const before = {
      vault: await vault(stores),
      sessions: await sessionsOf(stores, USER_ID),
    };

    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      personas: { [DEMO_JUNE_ID]: 'unchanged', [DEMO_THEO_ID]: 'unchanged' },
      profile: 'unchanged',
      agent: 'unchanged',
      schedule: 'unchanged',
      briefing: 'unchanged',
      spaces: { created: 0, updated: 0, unchanged: 1 },
      knowledge: { created: 0, unchanged: 11, removed: 0 },
      memory: { created: 0, updated: 0, unchanged: NOTE_COUNT, removed: 0 },
    });
    expect(await vault(stores)).toEqual(before.vault);
    expect((await sessionsOf(stores, USER_ID)).map(session => session.session_id)).toEqual(
      before.sessions.map(session => session.session_id),
    );
    expect(await stores.personaStore.listPersonas(owner)).toHaveLength(2);
    expect(world.queued).toHaveLength(11);
  });

  it('keeps what the demo did on the same day: a ticked task survives a second run', async () => {
    await seed(stores, DAY_ONE);
    const tasks = await stores.spaceStore.getSpace({ ...owner, space_id: DEMO_TASKS_SPACE_ID });
    const aggregate = await stores.spaceStore.getAggregate(owner);
    await stores.spaceStore.updateSpace({
      ...owner,
      space_id: DEMO_TASKS_SPACE_ID,
      name: 'Tasks',
      purpose: tasks?.purpose ?? 'Tasks',
      status: 'active',
      format: 'markdown',
      body: 'Edited by the assistant.',
      expected_revision: tasks?.revision ?? 0,
      expected_aggregate_revision: aggregate.revision,
    });

    await seed(stores, DAY_ONE);

    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toBe('Edited by the assistant.');
  });

  it('moves the dated content forward on the next day without duplicating anything', async () => {
    await seed(stores, DAY_ONE);

    const report = await seed(stores, DAY_TWO);

    // Only the meetup note carries a date.
    expect(report.memory).toEqual({ created: 0, updated: 1, unchanged: NOTE_COUNT - 1, removed: 0 });
    expect(report.briefing).toBe('updated');
    expect(report.spaces).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(report.knowledge).toMatchObject({ created: 0, unchanged: 11, removed: 0 });
    expect(await vault(stores)).toHaveLength(NOTE_COUNT);
    expect(await spaceBody(stores, DEMO_TASKS_SPACE_ID)).toContain('Appointment Nov 4, 10:00');
    const sessions = await sessionsOf(stores, USER_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.metadata['demo_seed_day']).toBe('2026-11-02');
  });

  it('seeds a rehearsal day that is not the real today', async () => {
    const today = parseIsoDay('2026-10-26');
    if (today === undefined) {
      throw new Error('Not a day.');
    }
    const rehearsal = buildDemoWorld({ today, timeZone: 'Europe/Lisbon', modelName: MODEL_NAME });

    await seedDemoWorld({ stores, scope, world: rehearsal, now: DAY_TWO });

    const [session] = await sessionsOf(stores, USER_ID);
    expect(session?.metadata['demo_seed_day']).toBe('2026-10-26');
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
      user_profile: 'My own words.',
      pinned_preferences: [],
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
            name: 'real-schedule',
            manifest: worldFor(DAY_ONE).scheduleManifest,
            created_by_subject: { subject_id: USER_ID, subject_type: 'user', subject_display_name: USER_ID },
            runFrom: DAY_ONE,
          },
          transaction,
        ),
      );
      await new Sessions({ sessionStore: stores.sessionStore }).create({
        tenant_id: TENANT_ID,
        session_id: 'real-session',
        created_by_subject: { subject_id: USER_ID, subject_type: 'user', subject_display_name: USER_ID },
        agent: { type: 'inline', spec: worldFor(DAY_ONE).agentSpec },
        external_id: null,
        metadata: { topic: 'mine' },
      });
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

    it('removes the synthetic records and nothing else', async () => {
      await addRealRecords();
      await seed(stores, DAY_ONE);
      const removed = await resetDemoWorld({ stores, scope });

      expect(removed).toEqual({
        personas: 2,
        profile: 1,
        agent: 1,
        schedule: 1,
        sessions: 1,
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
      expect((await sessionsOf(stores, USER_ID)).map(session => session.session_id)).toEqual(['real-session']);
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
        user_profile: 'My own words.',
        pinned_preferences: [],
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
});
