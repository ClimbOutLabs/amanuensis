import { Sessions } from '@truefoundry/trueforge-core/agent-session';
import { resetDemoWorld, seedDemoWorld } from '../../../../src/cli/demoSeed/seed';
import {
  buildDemoWorld,
  DEMO_AGENT_NAME,
  DEMO_MARKER,
  DEMO_PERSONA_ID,
  DEMO_SCHEDULE_NAME,
} from '../../../../src/cli/demoSeed/world';
import { createTestWorld, MODEL_NAME, TENANT_ID, USER_ID, type TestStores, type TestWorld } from './testStores';

const scope = { tenantId: TENANT_ID, userId: USER_ID };
const DAY_ONE = new Date('2026-10-15T08:00:00Z');
const DAY_TWO = new Date('2026-10-20T08:00:00Z');

function worldFor(now: Date) {
  return buildDemoWorld({ now, timeZone: 'Europe/Madrid', modelName: MODEL_NAME, runCodeAvailable: true });
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

  it('seeds the persona, memory, schedule and a finished briefing chat', async () => {
    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      persona: 'created',
      profile: 'created',
      agent: 'created',
      schedule: 'created',
      briefing: 'created',
      memory: { created: 8, updated: 0, unchanged: 0, removed: 0 },
    });

    const persona = await stores.personaStore.getPersona({
      tenant_id: TENANT_ID,
      created_by: USER_ID,
      id: DEMO_PERSONA_ID,
    });
    expect(persona?.display_name).toBe('Sol');

    const entries = await vault(stores);
    expect(entries).toHaveLength(8);
    expect(entries.every(entry => entry.text.includes(`> ${DEMO_MARKER}:`))).toBe(true);
    expect(entries.find(entry => entry.text.includes('Appointment today'))?.text).toContain('Thursday, October 15');

    const { data: schedules } = await stores.scheduleStore.listSchedules({
      tenant_id: TENANT_ID,
      limit: 10,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: undefined,
    });
    expect(schedules.map(schedule => schedule.name)).toEqual([DEMO_SCHEDULE_NAME]);
    expect(schedules[0]?.manifest.cron).toBe('30 7 * * *');

    const [session] = await sessionsOf(stores, USER_ID);
    expect(session?.title).toBe('Brief me before my 4 pm appointment');
    expect(session?.metadata).toMatchObject({ [DEMO_MARKER]: 'true', demo_seed_day: '2026-10-15' });
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

  it('recalls the appointment into the pre-baked briefing from the seeded memory', async () => {
    await seed(stores, DAY_ONE);
    const [session] = await sessionsOf(stores, USER_ID);
    const handle = await new Sessions({ sessionStore: stores.sessionStore }).get({
      tenant_id: TENANT_ID,
      session_id: session?.session_id ?? '',
    });
    const events = await handle?.listEvents({ limit: 100 });
    const recall = events?.data.find(item => item.event.type === 'aman.memory.recall')?.event;
    expect(JSON.stringify(recall)).toContain('Appointment today, Thursday, October 15');
  });

  it('is idempotent: a second run on the same day changes nothing', async () => {
    await seed(stores, DAY_ONE);
    const before = { vault: await vault(stores), sessions: await sessionsOf(stores, USER_ID) };

    const report = await seed(stores, DAY_ONE);

    expect(report).toMatchObject({
      persona: 'unchanged',
      profile: 'unchanged',
      agent: 'unchanged',
      schedule: 'unchanged',
      briefing: 'unchanged',
      memory: { created: 0, updated: 0, unchanged: 8, removed: 0 },
    });
    expect(await vault(stores)).toEqual(before.vault);
    expect((await sessionsOf(stores, USER_ID)).map(session => session.session_id)).toEqual(
      before.sessions.map(session => session.session_id),
    );
    expect(await stores.personaStore.listPersonas({ tenant_id: TENANT_ID, created_by: USER_ID })).toHaveLength(1);
  });

  it('moves the dated content forward on the next day without duplicating anything', async () => {
    await seed(stores, DAY_ONE);

    const report = await seed(stores, DAY_TWO);

    // Appointment, week overview and the balcony project carry dates; the other five notes do not.
    expect(report.memory).toEqual({ created: 0, updated: 3, unchanged: 5, removed: 0 });
    expect(report.briefing).toBe('updated');
    const entries = await vault(stores);
    expect(entries).toHaveLength(8);
    expect(entries.find(entry => entry.text.includes('Appointment today'))?.text).toContain('Tuesday, October 20');
    expect(entries.map(entry => entry.text).join('\n')).not.toContain('Appointment today, Thursday');
    const sessions = await sessionsOf(stores, USER_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.metadata['demo_seed_day']).toBe('2026-10-20');
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

      expect(removed).toEqual({ persona: 1, profile: 1, agent: 1, schedule: 1, sessions: 1, memory: 8 });
      expect(
        await stores.personaStore.getPersona({ tenant_id: TENANT_ID, created_by: USER_ID, id: DEMO_PERSONA_ID }),
      ).toBeUndefined();
      expect(
        await stores.personaStore.getPersona({ tenant_id: TENANT_ID, created_by: USER_ID, id: 'real-persona' }),
      ).toBeDefined();
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
        persona: 0,
        profile: 0,
        agent: 0,
        schedule: 0,
        sessions: 0,
        memory: 0,
      });

      await seed(stores, DAY_ONE);
      await resetDemoWorld({ stores, scope });
      const again = await seed(stores, DAY_ONE);

      expect(again.memory).toEqual({ created: 8, updated: 0, unchanged: 0, removed: 0 });
      expect(await vault(stores)).toHaveLength(8);
    });
  });
});
