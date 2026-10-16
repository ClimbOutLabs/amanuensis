import { Sessions, type CreatedBySubject, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { ulid } from 'ulid';
import type { IAgentStore } from '../../db/agentStore';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import { PersonaNameConflictError, type IPersonaStore } from '../../db/personaStore';
import type { IScheduleStore } from '../../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { WithTransaction } from '../../db/transaction';
import { formatMemoryBlock } from '../../runtime/memory/memoryCapability';
import type { MemoryClient } from '../../runtime/memory/memoryClient';
import { seedBriefingTurn } from './briefing';
import {
  DEMO_AGENT_NAME,
  DEMO_ID_PREFIX,
  DEMO_MARKER,
  DEMO_PERSONA_ID,
  DEMO_SCHEDULE_NAME,
  type DemoNote,
  type DemoWorld,
} from './world';

const MEMORY_TIMEOUT_MS = 10_000;
const MEMORY_RECALL_BUDGET_TOKENS = 2048;
const SHARED_VAULT = 'default';
const PAGE_SIZE = 100;
/** Session metadata pair every seeded session carries; reset finds them by it. */
const SESSION_MARKER: Record<string, string> = { [DEMO_MARKER]: 'true' };
const SEED_DAY_KEY = 'demo_seed_day';
const NOTE_MARKER_LINE = new RegExp(`^> ${DEMO_MARKER}:([a-z0-9-]+)$`);

export interface DemoSeedStores<TTransaction> {
  withTransaction: WithTransaction<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  memory: MemoryClient;
}

export interface DemoSeedScope {
  tenantId: string;
  /** The demo user's identity as login resolves it (the email when the login reference claim is email). */
  userId: string;
}

export type SeedOutcome = 'created' | 'updated' | 'unchanged' | 'kept_existing';

export interface SeedReport {
  persona: SeedOutcome;
  profile: SeedOutcome;
  agent: SeedOutcome;
  schedule: SeedOutcome;
  briefing: SeedOutcome;
  memory: { created: number; updated: number; unchanged: number; removed: number };
}

export interface ResetReport {
  persona: number;
  profile: number;
  agent: number;
  schedule: number;
  sessions: number;
  memory: number;
}

function subjectFor(userId: string): CreatedBySubject {
  return { subject_id: userId, subject_type: 'user', subject_display_name: userId };
}

function isSameJson({ left, right }: { left: unknown; right: unknown }): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A seeded memory entry as stored: `## <time>`, a blank line, the note, a blank line, `> demo_synthetic:<key>`. */
interface StoredNote {
  entryId: string;
  key: string;
  header: string;
  body: string;
}

function noteText({ header, note }: { header: string; note: DemoNote }): string {
  return `${header}\n\n${note.body}\n\n> ${DEMO_MARKER}:${note.key}`;
}

function parseStoredNote({ entryId, text }: { entryId: string; text: string }): StoredNote | undefined {
  const lines = text.trimEnd().split('\n');
  const marker = lines.pop()?.match(NOTE_MARKER_LINE);
  const key = marker?.[1];
  if (key === undefined) {
    return undefined;
  }
  const [header = '', ...rest] = lines;
  return { entryId, key, header, body: rest.join('\n').trim() };
}

async function listStoredNotes(memory: MemoryClient): Promise<StoredNote[]> {
  const outcome = await memory.listEntries({ namespace: SHARED_VAULT, timeoutMs: MEMORY_TIMEOUT_MS });
  if (!outcome.ok) {
    throw new Error(`Could not read the memory vault: ${outcome.reason}`);
  }
  return outcome.entries.flatMap(entry => {
    const stored = parseStoredNote({ entryId: entry.id, text: entry.text });
    return stored === undefined ? [] : [stored];
  });
}

async function seedMemory({
  memory,
  notes,
  now,
}: {
  memory: MemoryClient;
  notes: DemoNote[];
  now: Date;
}): Promise<SeedReport['memory']> {
  const report = { created: 0, updated: 0, unchanged: 0, removed: 0 };
  const stored = await listStoredNotes(memory);
  const wanted = new Set(notes.map(note => note.key));

  for (const note of notes) {
    const existing = stored.find(candidate => candidate.key === note.key);
    if (existing === undefined) {
      const timestamp = now.toISOString();
      // A fresh operation id each time: a reset leaves the old id on record, and a reused one would skip the write.
      const retained = await memory.retain({
        items: [
          {
            content: note.body,
            timestamp,
            context: `${DEMO_MARKER}:${note.key}`,
            document_id: `${DEMO_ID_PREFIX}-${note.key}`,
          },
        ],
        operationId: ulid(),
        timeoutMs: MEMORY_TIMEOUT_MS,
      });
      if (!retained.ok) {
        throw new Error(`Could not write memory note "${note.key}": ${retained.reason ?? 'unknown error'}`);
      }
      report.created += 1;
    } else if (existing.body === note.body) {
      report.unchanged += 1;
    } else {
      const updated = await memory.updateEntry({
        entryId: existing.entryId,
        text: noteText({ header: existing.header, note }),
        timeoutMs: MEMORY_TIMEOUT_MS,
      });
      if (!updated.ok) {
        throw new Error(`Could not update memory note "${note.key}": ${updated.reason}`);
      }
      report.updated += 1;
    }
  }

  for (const leftover of stored.filter(candidate => !wanted.has(candidate.key))) {
    const removed = await memory.deleteEntry({ entryId: leftover.entryId, timeoutMs: MEMORY_TIMEOUT_MS });
    if (!removed.ok) {
      throw new Error(`Could not remove memory note "${leftover.key}": ${removed.reason}`);
    }
    report.removed += 1;
  }
  return report;
}

async function seedPersona<TTransaction>({
  stores,
  scope,
  world,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
}): Promise<SeedOutcome> {
  const key = { tenant_id: scope.tenantId, created_by: scope.userId, id: DEMO_PERSONA_ID };
  const existing = await stores.personaStore.getPersona(key);
  const content = world.persona;
  try {
    if (existing === undefined) {
      await stores.personaStore.createPersona({ ...key, updated_by: scope.userId, ...content });
      return 'created';
    }
    if (
      isSameJson({
        left: [existing.display_name, existing.aliases, existing.instructions, existing.model_name],
        right: [content.display_name, content.aliases, content.instructions, content.model_name],
      })
    ) {
      return 'unchanged';
    }
    await stores.personaStore.updatePersona({ ...key, updated_by: scope.userId, ...content });
    return 'updated';
  } catch (error) {
    if (error instanceof PersonaNameConflictError) {
      throw new Error(
        `The demo persona "${content.display_name}" clashes with an existing persona name or alias; rename or delete that persona first.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function seedProfile<TTransaction>({
  stores,
  scope,
  world,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
}): Promise<SeedOutcome> {
  const key = { tenant_id: scope.tenantId, created_by: scope.userId };
  const existing = await stores.personalizationStore.getProfile(key);
  if (existing !== undefined && !(existing.user_profile ?? '').includes(DEMO_MARKER)) {
    // The user already wrote their own profile; the seed never overwrites a real one.
    return 'kept_existing';
  }
  if (existing !== undefined) {
    const { profile } = world;
    const current = [
      existing.assistant_name,
      existing.assistant_identity,
      existing.voice_guidance,
      existing.user_name,
      existing.address_as,
      existing.user_profile,
      existing.pinned_preferences,
      existing.learning_enabled,
    ];
    const wanted = [
      profile.assistant_name,
      profile.assistant_identity,
      profile.voice_guidance,
      profile.user_name,
      profile.address_as,
      profile.user_profile,
      profile.pinned_preferences,
      profile.learning_enabled,
    ];
    if (isSameJson({ left: current, right: wanted })) {
      return 'unchanged';
    }
  }
  await stores.personalizationStore.upsertProfile({ ...key, updated_by: scope.userId, ...world.profile });
  return existing === undefined ? 'created' : 'updated';
}

async function seedAgent<TTransaction>({
  stores,
  scope,
  world,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
}): Promise<{ outcome: SeedOutcome; agentId: string }> {
  const existing = await stores.agentStore.getAgent({ tenant_id: scope.tenantId, name: DEMO_AGENT_NAME });
  if (existing === undefined) {
    const created = await stores.agentStore.createAgent({
      tenant_id: scope.tenantId,
      name: DEMO_AGENT_NAME,
      description: world.agentDescription,
      manifest: world.agentSpec,
      external_id: null,
      created_by_subject: subjectFor(scope.userId),
    });
    return { outcome: 'created', agentId: created.id };
  }
  if (
    existing.description === world.agentDescription &&
    isSameJson({ left: existing.manifest, right: world.agentSpec })
  ) {
    return { outcome: 'unchanged', agentId: existing.id };
  }
  await stores.agentStore.updateAgent({
    tenant_id: scope.tenantId,
    id: existing.id,
    description: world.agentDescription,
    manifest: world.agentSpec,
  });
  return { outcome: 'updated', agentId: existing.id };
}

async function findSchedule<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}) {
  const { data } = await stores.scheduleStore.listSchedules({
    tenant_id: scope.tenantId,
    limit: PAGE_SIZE,
    page_token: undefined,
    agent_names: [DEMO_AGENT_NAME],
    created_by_or_agent_ids: undefined,
  });
  return data.find(schedule => schedule.name === DEMO_SCHEDULE_NAME);
}

async function seedSchedule<TTransaction>({
  stores,
  scope,
  world,
  agentId,
  now,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
  agentId: string;
  now: Date;
}): Promise<SeedOutcome> {
  const existing = await findSchedule({ stores, scope });
  if (existing === undefined) {
    await stores.withTransaction(transaction =>
      stores.scheduleStore.createScheduleAndRun(
        {
          tenant_id: scope.tenantId,
          agent_id: agentId,
          agent_name: DEMO_AGENT_NAME,
          name: DEMO_SCHEDULE_NAME,
          manifest: world.scheduleManifest,
          created_by_subject: subjectFor(scope.userId),
          runFrom: now,
        },
        transaction,
      ),
    );
    return 'created';
  }
  if (existing.created_by_subject.subject_id !== scope.userId) {
    throw new Error(
      `The demo schedule already belongs to ${existing.created_by_subject.subject_id}; seed with that --user or run --reset for them first.`,
    );
  }
  if (isSameJson({ left: existing.manifest, right: world.scheduleManifest })) {
    return 'unchanged';
  }
  await stores.withTransaction(transaction =>
    stores.scheduleStore.updateScheduleAndRun(
      {
        tenant_id: scope.tenantId,
        id: existing.id,
        name: DEMO_SCHEDULE_NAME,
        manifest: world.scheduleManifest,
        runFrom: now,
      },
      transaction,
    ),
  );
  return 'updated';
}

async function listSyntheticSessions<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}) {
  const { data } = await stores.sessionStore.listSessions({
    tenant_id: scope.tenantId,
    limit: PAGE_SIZE,
    page_token: undefined,
    order: undefined,
    start_timestamp: undefined,
    end_timestamp: undefined,
    agent_id: undefined,
    created_by_or_agent_ids: { created_by_subject_id: scope.userId, agent_ids: [] },
    metadata: SESSION_MARKER,
    source_type: undefined,
    source_id: undefined,
  });
  return data;
}

async function seedBriefing<TTransaction>({
  stores,
  scope,
  world,
  now,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
  now: Date;
}): Promise<SeedOutcome> {
  const existing = await listSyntheticSessions({ stores, scope });
  if (existing.length > 0 && existing.every(session => session.metadata[SEED_DAY_KEY] === world.day)) {
    return 'unchanged';
  }
  // The briefing quotes today's times, so a new day replaces it rather than leaving a stale one behind.
  for (const session of existing) {
    await stores.sessionStore.deleteSession({ tenant_id: scope.tenantId, session_id: session.session_id });
  }

  const recalled = await stores.memory.recall({
    query: world.briefing.userText,
    maxTokens: MEMORY_RECALL_BUDGET_TOKENS,
    queryTimestamp: now.toISOString(),
    entityTokens: 0,
    timeoutMs: MEMORY_TIMEOUT_MS,
  });
  if (!recalled.ok) {
    throw new Error(`Could not recall the demo memory for the briefing: ${recalled.reason}`);
  }
  const block = formatMemoryBlock({
    results: recalled.results,
    entities: [],
    budgetTokens: MEMORY_RECALL_BUDGET_TOKENS,
  });

  const sessions = new Sessions<SessionCustom, TurnCustom>({ sessionStore: stores.sessionStore });
  const session = await sessions.create({
    tenant_id: scope.tenantId,
    session_id: ulid().toLowerCase(),
    created_by_subject: subjectFor(scope.userId),
    agent: { type: 'inline', spec: world.agentSpec },
    external_id: null,
    metadata: { ...SESSION_MARKER, [SEED_DAY_KEY]: world.day },
  });
  await seedBriefingTurn({
    store: stores.sessionStore,
    sessionId: session.session_id,
    briefing: world.briefing,
    memoryBlock: block,
    now,
  });
  return existing.length > 0 ? 'updated' : 'created';
}

/** Writes (or refreshes) one synthetic world. Safe to run again: unchanged records are left alone. */
export async function seedDemoWorld<TTransaction>({
  stores,
  scope,
  world,
  now,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
  now: Date;
}): Promise<SeedReport> {
  const memory = await seedMemory({ memory: stores.memory, notes: world.notes, now });
  const persona = await seedPersona({ stores, scope, world });
  const profile = await seedProfile({ stores, scope, world });
  const agent = await seedAgent({ stores, scope, world });
  const schedule = await seedSchedule({ stores, scope, world, agentId: agent.agentId, now });
  const briefing = await seedBriefing({ stores, scope, world, now });
  return { persona, profile, agent: agent.outcome, schedule, briefing, memory };
}

/** Removes only what carries the synthetic marker; everything the user made themselves stays. */
export async function resetDemoWorld<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<ResetReport> {
  const report: ResetReport = { persona: 0, profile: 0, agent: 0, schedule: 0, sessions: 0, memory: 0 };

  for (const session of await listSyntheticSessions({ stores, scope })) {
    await stores.sessionStore.deleteSession({ tenant_id: scope.tenantId, session_id: session.session_id });
    report.sessions += 1;
  }

  const schedule = await findSchedule({ stores, scope });
  if (schedule?.created_by_subject.subject_id === scope.userId) {
    await stores.scheduleStore.deleteSchedule({ tenant_id: scope.tenantId, id: schedule.id });
    report.schedule += 1;
  }

  // The agent is shared by name, so it goes only once no schedule is left on it.
  const agent = await stores.agentStore.getAgent({ tenant_id: scope.tenantId, name: DEMO_AGENT_NAME });
  if (agent !== undefined) {
    const { data: remaining } = await stores.scheduleStore.listSchedules({
      tenant_id: scope.tenantId,
      limit: 1,
      page_token: undefined,
      agent_names: [DEMO_AGENT_NAME],
      created_by_or_agent_ids: undefined,
    });
    if (remaining.length === 0) {
      await stores.agentStore.deleteAgent({ tenant_id: scope.tenantId, id: agent.id });
      report.agent += 1;
    }
  }

  const personaKey = { tenant_id: scope.tenantId, created_by: scope.userId, id: DEMO_PERSONA_ID };
  if ((await stores.personaStore.getPersona(personaKey)) !== undefined) {
    await stores.personaStore.deletePersona(personaKey);
    report.persona += 1;
  }

  const profileKey = { tenant_id: scope.tenantId, created_by: scope.userId };
  const profile = await stores.personalizationStore.getProfile(profileKey);
  if (profile !== undefined && (profile.user_profile ?? '').includes(DEMO_MARKER)) {
    await stores.personalizationStore.deleteProfile(profileKey);
    report.profile += 1;
  }

  for (const note of await listStoredNotes(stores.memory)) {
    const removed = await stores.memory.deleteEntry({ entryId: note.entryId, timeoutMs: MEMORY_TIMEOUT_MS });
    if (!removed.ok) {
      throw new Error(`Could not remove memory note "${note.key}": ${removed.reason}`);
    }
    report.memory += 1;
  }
  return report;
}
