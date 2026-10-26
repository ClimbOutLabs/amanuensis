import { Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { wipeUserData } from '../../../../src/cli/demoSeed/fresh';
import { seedDemoWorld } from '../../../../src/cli/demoSeed/seed';
import { dayInZone } from '../../../../src/cli/demoSeed/storyDays.mjs';
import { buildDemoWorld, DEMO_JUNE_ID, DEMO_THEO_ID } from '../../../../src/cli/demoSeed/world';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { createTestWorld, MODEL_NAME, TENANT_ID, USER_ID, type TestStores, type TestWorld } from './testStores';

const OTHER_ID = 'visitor@example.com';
const NOW = new Date('2026-10-26T08:00:00Z');
const timeZone = 'Europe/Lisbon';

function subjectOf(userId: string): CreatedBySubject {
  return { subject_id: userId, subject_type: 'user', subject_display_name: userId };
}

const demoWorld = buildDemoWorld({ today: dayInZone({ now: NOW, timeZone }), timeZone, modelName: MODEL_NAME });

describe('start fresh against the real stores', () => {
  let world: TestWorld;
  let stores: TestStores;

  beforeEach(async () => {
    world = await createTestWorld();
    stores = world.stores;
  });

  afterEach(async () => {
    await world.teardown();
  });

  const seed = () =>
    seedDemoWorld({ stores, scope: { tenantId: TENANT_ID, userId: USER_ID }, world: demoWorld, now: NOW });
  const wipe = (userId: string) => wipeUserData({ stores, scope: { tenantId: TENANT_ID, userId } });

  async function addPersonMadeRecords(userId: string, suffix: string) {
    const owner = { tenant_id: TENANT_ID, created_by: userId };
    await new Sessions({ sessionStore: new SqliteSessionStore(world.db) }).create({
      tenant_id: TENANT_ID,
      session_id: `chat-${suffix}`,
      created_by_subject: subjectOf(userId),
      agent: { type: 'inline', spec: demoWorld.agentSpec },
      external_id: null,
      metadata: {},
    });
    await stores.turnArtifactStore.recordStoredArtifact({
      tenant_id: TENANT_ID,
      session_id: `chat-${suffix}`,
      turn_id: 't1',
      path: `/tmp/${suffix}.txt`,
      name: `${suffix}.txt`,
      data: Buffer.from(`file of ${suffix}`),
      mime: 'text/plain',
    });
    await stores.spaceStore.createSpace({
      ...owner,
      id: `space-${suffix}`,
      name: `Trip ${suffix}`,
      purpose: 'Mine.',
      status: 'active',
      format: 'markdown',
      body: 'Packing list.',
      expected_aggregate_revision: (await stores.spaceStore.getAggregate(owner)).revision,
    });
    await stores.personaStore.createPersona({
      ...owner,
      updated_by: userId,
      id: `persona-${suffix}`,
      display_name: `Marlow ${suffix}`,
      aliases: [],
      instructions: 'A persona somebody made.',
      model_name: MODEL_NAME,
    });
    const agent = await stores.agentStore.createAgent({
      host_managed: false,
      tenant_id: TENANT_ID,
      name: `agent-${suffix}`,
      description: 'Mine.',
      manifest: demoWorld.agentSpec,
      external_id: null,
      created_by_subject: subjectOf(userId),
    });
    await stores.withTransaction(transaction =>
      stores.scheduleStore.createScheduleAndRun(
        {
          tenant_id: TENANT_ID,
          agent_id: agent.id,
          agent_name: agent.name,
          persona_id: null,
          name: `schedule-${suffix}`,
          manifest: demoWorld.scheduleManifest,
          created_by_subject: subjectOf(userId),
          runFrom: NOW,
        },
        transaction,
      ),
    );
    await stores.personalizationStore.upsertProfile({
      ...owner,
      updated_by: userId,
      assistant_name: null,
      assistant_identity: null,
      voice_guidance: null,
      user_name: `Name ${suffix}`,
      address_as: null,
      user_profile: `About ${suffix}.`,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: `Learned about ${suffix}.`,
      learning_enabled: true,
    });
  }

  async function retainShared(text: string) {
    const retained = await stores.memory.retain({
      items: [{ content: text, timestamp: NOW.toISOString(), document_id: text }],
      operationId: text,
      timeoutMs: 5000,
    });
    expect(retained.ok).toBe(true);
  }

  async function snapshot(userId: string, suffix: string) {
    const owner = { tenant_id: TENANT_ID, created_by: userId };
    const { data: schedules } = await stores.scheduleStore.listSchedules({
      tenant_id: TENANT_ID,
      limit: 50,
      page_token: undefined,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: userId, agent_ids: [] },
    });
    return {
      chat: await new SqliteSessionStore(world.db).getSession({ tenant_id: TENANT_ID, session_id: `chat-${suffix}` }),
      file: await stores.turnArtifactStore.getArtifact({
        tenant_id: TENANT_ID,
        session_id: `chat-${suffix}`,
        turn_id: 't1',
        path: `/tmp/${suffix}.txt`,
      }),
      spaces: (await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: 50 })).map(space => space.id),
      personas: (await stores.personaStore.listPersonas(owner)).map(persona => persona.id),
      schedules: schedules.map(schedule => schedule.name),
      profile: await stores.personalizationStore.getProfile(owner),
    };
  }

  async function sharedMemory() {
    const outcome = await stores.memory.listEntries({ namespace: 'default', timeoutMs: 5000 });
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    return outcome.entries.map(entry => entry.text);
  }

  it('leaves none of what the demo person made, and the seed is back exactly as a first seed', async () => {
    await seed();
    const firstSeed = {
      spaces: (await snapshot(USER_ID, 'none')).spaces,
      personas: (await snapshot(USER_ID, 'none')).personas,
      schedules: (await snapshot(USER_ID, 'none')).schedules,
      memory: await sharedMemory(),
    };
    await addPersonMadeRecords(USER_ID, 'mine');
    await retainShared('A note the judge asked me to keep.');
    await stores.knowledge.addTextDocument({
      personaId: 'persona-mine',
      title: 'Upload',
      text: 'An uploaded file.',
      sourceLabel: 'Pasted text',
    });

    const removed = await wipe(USER_ID);
    const report = await seed();

    expect(removed).toMatchObject({ sessions: 1, spaces: 2, personas: 3, profile: 1 });
    expect(removed.memory).toBeGreaterThanOrEqual(2);
    const after = await snapshot(USER_ID, 'mine');
    expect(after.chat).toBeUndefined();
    expect(after.file).toBeUndefined();
    expect(after.spaces).toEqual(firstSeed.spaces);
    expect(after.personas).toEqual(firstSeed.personas);
    expect(after.personas).not.toContain('persona-mine');
    expect(after.schedules).toEqual(firstSeed.schedules);
    expect(await stores.knowledge.listDocuments({ personaId: 'persona-mine' })).toEqual([]);
    expect(await sharedMemory()).toHaveLength(firstSeed.memory.length);
    expect((await sharedMemory()).join('\n')).not.toContain('the judge asked me to keep');
    expect(after.profile?.learned_profile ?? null).toBe(null);
    expect(after.profile?.user_name).toBe(demoWorld.profile.user_name);
    expect(report).toMatchObject({
      personas: { [DEMO_JUNE_ID]: 'created', [DEMO_THEO_ID]: 'created' },
      profile: 'created',
      schedule: 'created',
      spaces: { created: 1, updated: 0, unchanged: 0 },
      knowledge: { created: 11, unchanged: 0, removed: 0 },
      memory: { created: firstSeed.memory.length, updated: 0, unchanged: 0, removed: 0 },
    });
  });

  it("never touches another user's chats, files, spaces, personas, schedules or profile", async () => {
    await addPersonMadeRecords(USER_ID, 'mine');
    await addPersonMadeRecords(OTHER_ID, 'theirs');
    const before = await snapshot(OTHER_ID, 'theirs');

    await wipe(USER_ID);

    expect(await snapshot(OTHER_ID, 'theirs')).toEqual(before);
    expect(before.chat).toBeDefined();
    expect(before.file).toBeDefined();
    expect((await snapshot(USER_ID, 'mine')).chat).toBeUndefined();
  });

  it('empties the vault of a persona the user made', async () => {
    await addPersonMadeRecords(USER_ID, 'mine');
    const personaClient = new MarkdownMemoryClient({
      baseDir: world.memoryDir,
      namespace: TENANT_ID,
      vaultScope: { personaName: 'Marlow mine', personaId: 'persona-mine' },
    });
    const retained = await personaClient.retain({
      items: [{ content: 'Only in the persona vault', timestamp: NOW.toISOString(), document_id: 'vault-note' }],
      operationId: 'vault-op',
      timeoutMs: 5000,
    });
    expect(retained.ok).toBe(true);
    const vaultOf = async () => {
      const listed = await stores.memory.listEntries({ namespace: 'persona:Marlow mine', timeoutMs: 5000 });
      return listed.ok ? listed.entries : [];
    };
    expect(await vaultOf()).toHaveLength(1);

    const removed = await wipe(USER_ID);

    expect(removed.memory).toBe(1);
    expect(await vaultOf()).toEqual([]);
  });

  it('is safe to run twice in a row and on an empty instance', async () => {
    await seed();
    await addPersonMadeRecords(USER_ID, 'mine');

    await wipe(USER_ID);
    const second = await wipe(USER_ID);
    const third = await wipe(USER_ID);

    expect(second).toMatchObject({ sessions: 0, folders: 0, schedules: 0, spaces: 0, personas: 0, profile: 0 });
    expect(third).toEqual(second);
    await seed();
    await wipe(USER_ID);
    await expect(seed()).resolves.toMatchObject({ profile: 'created', schedule: 'created' });
  });
});
