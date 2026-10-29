import {
  AgentSpecSchema,
  type AgentSpec,
  type CreatedBySubject,
  type ISessionStore,
} from '@truefoundry/trueforge-core/agent-session';
import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { MORNING_BRIEF_SCHEDULE_NAME } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { ulid } from 'ulid';
import type { Logger } from 'winston';
import type { McpCatalog } from '../../catalog/McpCatalog';
import type { SkillCatalog } from '../../catalog/SkillCatalog';
import type { IAgentStore } from '../../db/agentStore';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IMcpServerStore } from '../../db/mcpServerStore';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import { PersonaNameConflictError, type IPersonaStore } from '../../db/personaStore';
import type { IScheduleStore } from '../../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ISkillStore } from '../../db/skillStore';
import type { ISpaceStore } from '../../db/spaceStore';
import type { WithTransaction } from '../../db/transaction';
import type { ITurnArtifactStore } from '../../db/turnArtifactStore';
import { seedDefaultSearchProvider, type DefaultSearchProviderOutcome } from '../../runtime/defaultSearchProvider';
import { registerMailConnector } from '../../runtime/mailConnector';
import type { MemoryClient } from '../../runtime/memory/memoryClient';
import type { SkillManifest } from '../../schemas/skill';
import { SPACE_LIST_LIMIT } from '../../schemas/space';
import { knowledgeDocumentId, type DemoKnowledgeLibrary } from './knowledgeLibrary';
import type { DemoNote, DemoPersona, DemoSpace, DemoWorld } from './model';
import { DEMO_AGENT_NAME, DEMO_ID_PREFIX, DEMO_MARKER, DEMO_USER_PROFILE } from './world';

const MEMORY_TIMEOUT_MS = 10_000;
/** Indexing a library embeds every passage on the CPU; a first run may also load the search model. */
const KNOWLEDGE_SETTLE_TIMEOUT_MS = 180_000;
const SHARED_VAULT = 'default';
const PAGE_SIZE = 100;
/** What earlier seeds stamped; their records are cleared or rewritten on the next seed or reset. */
const EARLIER_MARKER = 'demo_synthetic';
const EARLIER_ID_PREFIX = 'demo-synthetic';
const EARLIER_AGENT_NAME = `${EARLIER_ID_PREFIX}-assistant`;
const NOTE_MARKER_LINE = new RegExp(`^> (${DEMO_MARKER}|${EARLIER_MARKER}):([a-z0-9-]+)$`);

export interface DemoSeedStores<TTransaction> {
  withTransaction: WithTransaction<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  /** Clears chats an earlier version of the seed wrote, and every chat for `--fresh`. */
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  /** Chat deletion leaves saved files behind, so `--fresh` removes them through this store. */
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  /** Where connector registrations live; the seed ensures the demo's two connectors here. */
  mcpServerStore: IMcpServerStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Where a person's skills live; the seed enables the demo's catalog skill here. */
  skillStore: ISkillStore<TTransaction>;
  knowledge: DemoKnowledgeLibrary;
  memory: MemoryClient;
}

/** What the seed needs from the instance configuration to ensure the demo's connectors and skill. */
export interface DemoSeedConnectors {
  /** The mail sidecar's MCP endpoint the instance is configured with; undefined leaves email unregistered. */
  mailUrl: string | undefined;
  catalog: McpCatalog;
  skillCatalog: SkillCatalog;
  logger: Logger;
}

export interface DemoSeedScope {
  tenantId: string;
  /** The demo user's identity as login resolves it (the email when the login reference claim is email). */
  userId: string;
}

export type SeedOutcome = 'created' | 'updated' | 'unchanged' | 'kept_existing';

export interface SeedReport {
  /** Outcome per persona id. */
  personas: Record<string, SeedOutcome>;
  profile: SeedOutcome;
  agent: SeedOutcome;
  schedule: SeedOutcome;
  spaces: { created: number; updated: number; unchanged: number };
  /** `still_indexing` counts documents not ready when the wait ended; the server finishes them on its next start. */
  knowledge: { created: number; unchanged: number; removed: number; still_indexing: number };
  memory: { created: number; updated: number; unchanged: number; removed: number };
  /** The demo's connectors, ensured as part of the seed: email registered from the configured endpoint, the default search connector offered. `failed` is reported, never fatal. */
  connectors: { email: 'registered' | 'unconfigured' | 'failed'; search: DefaultSearchProviderOutcome | 'failed' };
  /** The demo's catalog skill, enabled as part of the seed. `failed` is reported, never fatal. */
  skills: { tenX: 'enabled' | 'already_enabled' | 'failed' };
}

type EarlierReport = Pick<ResetReport, 'personas' | 'agent' | 'schedule' | 'sessions' | 'spaces'>;

export interface ResetReport {
  personas: number;
  profile: number;
  agent: number;
  schedule: number;
  sessions: number;
  spaces: number;
  memory: number;
}

function subjectFor(userId: string): CreatedBySubject {
  return { subject_id: userId, subject_type: 'user', subject_display_name: userId };
}

function isSameJson({ left, right }: { left: unknown; right: unknown }): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDemoId(id: string): boolean {
  return id.startsWith(`${DEMO_ID_PREFIX}-`);
}

function isEarlierId(id: string): boolean {
  return id.startsWith(`${EARLIER_ID_PREFIX}-`);
}

function isSeededProfile(userProfile: string | null): boolean {
  return userProfile === DEMO_USER_PROFILE || (userProfile ?? '').includes(EARLIER_MARKER);
}

/** A seeded memory entry as stored: `## <time>`, a blank line, the note, a blank line, `> <marker>:<key>`. */
interface StoredNote {
  entryId: string;
  key: string;
  header: string;
  body: string;
  /** False when an earlier seed's marker is on it, so the next seed rewrites it. */
  current: boolean;
}

function noteText({ header, note }: { header: string; note: DemoNote }): string {
  return `${header}\n\n${note.body}\n\n> ${DEMO_MARKER}:${note.key}`;
}

function parseStoredNote({ entryId, text }: { entryId: string; text: string }): StoredNote | undefined {
  const lines = text.trimEnd().split('\n');
  const marker = lines.pop()?.match(NOTE_MARKER_LINE);
  const key = marker?.[2];
  if (key === undefined) {
    return undefined;
  }
  const [header = '', ...rest] = lines;
  return { entryId, key, header, body: rest.join('\n').trim(), current: marker?.[1] === DEMO_MARKER };
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
    } else if (existing.current && existing.body === note.body) {
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
  persona,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  persona: DemoPersona;
}): Promise<SeedOutcome> {
  const key = { tenant_id: scope.tenantId, created_by: scope.userId, id: persona.id };
  const existing = await stores.personaStore.getPersona(key);
  const content = persona.content;
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

/**
 * Brings a persona's library to exactly the wanted documents. A document whose title or text changed carries a
 * new id, so it is replaced; a failed one is tried again.
 */
async function seedKnowledge({
  library,
  persona,
}: {
  library: DemoKnowledgeLibrary;
  persona: DemoPersona;
}): Promise<Pick<SeedReport['knowledge'], 'created' | 'unchanged' | 'removed'>> {
  const report = { created: 0, unchanged: 0, removed: 0 };
  const wanted = persona.knowledge.map(document => ({ ...document, id: knowledgeDocumentId(document) }));
  const existing = await library.listDocuments({ personaId: persona.id });
  const kept = new Set<string>();
  for (const document of existing) {
    const keep = document.status !== 'failed' && wanted.some(candidate => candidate.id === document.id);
    if (keep) {
      kept.add(document.id);
      report.unchanged += 1;
    } else {
      await library.deleteDocument({ personaId: persona.id, documentId: document.id });
      report.removed += 1;
    }
  }
  for (const document of wanted) {
    if (!kept.has(document.id)) {
      await library.addTextDocument({
        personaId: persona.id,
        documentId: document.id,
        title: document.title,
        text: document.text,
        sourceLabel: document.sourceLabel,
      });
      report.created += 1;
    }
  }
  return report;
}

async function seedPersonas<TTransaction>({
  stores,
  scope,
  world,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
}): Promise<{ personas: SeedReport['personas']; knowledge: SeedReport['knowledge'] }> {
  const personas: SeedReport['personas'] = {};
  const knowledge = { created: 0, unchanged: 0, removed: 0, still_indexing: 0 };
  for (const persona of world.personas) {
    personas[persona.id] = await seedPersona({ stores, scope, persona });
    const report = await seedKnowledge({ library: stores.knowledge, persona });
    knowledge.created += report.created;
    knowledge.unchanged += report.unchanged;
    knowledge.removed += report.removed;
  }
  for (const persona of world.personas) {
    const pending = await stores.knowledge.settle({ personaId: persona.id, timeoutMs: KNOWLEDGE_SETTLE_TIMEOUT_MS });
    knowledge.still_indexing += pending.length;
  }
  return { personas, knowledge };
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
  if (existing !== undefined && !isSeededProfile(existing.user_profile)) {
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
      existing.help_areas,
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
      profile.help_areas,
      profile.learning_enabled,
    ];
    if (isSameJson({ left: current, right: wanted })) {
      return 'unchanged';
    }
  }
  await stores.personalizationStore.upsertProfile({ ...key, updated_by: scope.userId, ...world.profile });
  return existing === undefined ? 'created' : 'updated';
}

/**
 * The brief reads mail and the calendar and searches the web, so the agent gets each of those connectors
 * the instance has. Connectors someone attached stay attached, settings and all; the seed owns the rest of its spec.
 */
function withDemoConnectors({
  wanted,
  stored,
  available,
}: {
  wanted: AgentSpec;
  stored: AgentSpec | undefined;
  available: readonly string[];
}): AgentSpec {
  const attached = stored?.mcp_servers ?? [];
  const missing = available.filter(name => !attached.some(entry => entry.name === name));
  if (attached.length === 0 && missing.length === 0) {
    return wanted;
  }
  return AgentSpecSchema.parse({ ...wanted, mcp_servers: [...attached, ...missing.map(name => ({ name }))] });
}

/** Mail, calendar and the web search provider, each only when the instance has it registered. */
async function demoConnectorNames<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<string[]> {
  const servers = await stores.mcpServerStore.listServers({ tenant_id: scope.tenantId, names: undefined });
  const names = servers.map(server => server.name);
  const search = servers.filter(
    server => server.manifest.type === 'remote' && server.manifest.search_provider === true,
  );
  return [
    ...[MAIL_CONNECTOR_NAME, CALDAV_SERVER_NAME].filter(name => names.includes(name)),
    ...search.map(server => server.name),
  ];
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
  const available = await demoConnectorNames({ stores, scope });
  const manifest = withDemoConnectors({ wanted: world.agentSpec, stored: existing?.manifest, available });
  if (existing === undefined) {
    const created = await stores.agentStore.createAgent({
      tenant_id: scope.tenantId,
      name: DEMO_AGENT_NAME,
      description: world.agentDescription,
      manifest,
      external_id: null,
      host_managed: false,
      created_by_subject: subjectFor(scope.userId),
    });
    return { outcome: 'created', agentId: created.id };
  }
  if (existing.description === world.agentDescription && isSameJson({ left: existing.manifest, right: manifest })) {
    return { outcome: 'unchanged', agentId: existing.id };
  }
  await stores.agentStore.updateAgent({
    tenant_id: scope.tenantId,
    id: existing.id,
    description: world.agentDescription,
    manifest,
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
  return data.find(schedule => schedule.name === MORNING_BRIEF_SCHEDULE_NAME);
}

/**
 * What earlier versions of the seed wrote under names or markers this one no longer uses: their agent and its
 * schedules, personas with their libraries, spaces and chats. Runs before seeding, so the new personas do not
 * clash with the old ones by name.
 */
async function removeEarlierSeeds<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<EarlierReport> {
  const removed: EarlierReport = { personas: 0, agent: 0, schedule: 0, sessions: 0, spaces: 0 };
  const owner = { tenant_id: scope.tenantId, created_by: scope.userId };
  const { data: schedules } = await stores.scheduleStore.listSchedules({
    tenant_id: scope.tenantId,
    limit: PAGE_SIZE,
    page_token: undefined,
    agent_names: [EARLIER_AGENT_NAME],
    created_by_or_agent_ids: undefined,
  });
  for (const schedule of schedules.filter(candidate => candidate.created_by_subject.subject_id === scope.userId)) {
    await stores.scheduleStore.deleteSchedule({ tenant_id: scope.tenantId, id: schedule.id });
    removed.schedule += 1;
  }
  removed.agent += await removeAgentWhenUnused({ stores, scope, agentName: EARLIER_AGENT_NAME });

  for (const persona of (await stores.personaStore.listPersonas(owner)).filter(candidate =>
    isEarlierId(candidate.id),
  )) {
    await stores.personaStore.deletePersona({ ...owner, id: persona.id });
    await stores.knowledge.deleteLibrary({ personaId: persona.id });
    removed.personas += 1;
  }

  const spaces = await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: SPACE_LIST_LIMIT });
  for (const space of spaces.filter(candidate => isEarlierId(candidate.id))) {
    await stores.spaceStore.deleteSpace({ ...owner, space_id: space.id, expected_revision: space.revision });
    removed.spaces += 1;
  }

  // Deleting a chat leaves its audit rows in place.
  for (;;) {
    const { data: sessions } = await stores.sessionStore.listSessions({
      tenant_id: scope.tenantId,
      limit: PAGE_SIZE,
      page_token: undefined,
      order: undefined,
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      created_by_or_agent_ids: { created_by_subject_id: scope.userId, agent_ids: [] },
      metadata: { [EARLIER_MARKER]: 'true' },
      source_type: undefined,
      source_id: undefined,
      folder_id: undefined,
      no_folder: false,
    });
    if (sessions.length === 0) {
      return removed;
    }
    for (const session of sessions) {
      await stores.sessionStore.deleteSession({ tenant_id: scope.tenantId, session_id: session.session_id });
      removed.sessions += 1;
    }
  }
}

/** The agent is shared by name, so it goes only once no schedule is left on it. */
async function removeAgentWhenUnused<TTransaction>({
  stores,
  scope,
  agentName,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  agentName: string;
}): Promise<number> {
  const agent = await stores.agentStore.getAgent({ tenant_id: scope.tenantId, name: agentName });
  if (agent === undefined) {
    return 0;
  }
  const { data: remaining } = await stores.scheduleStore.listSchedules({
    tenant_id: scope.tenantId,
    limit: 1,
    page_token: undefined,
    agent_names: [agentName],
    created_by_or_agent_ids: undefined,
  });
  if (remaining.length > 0) {
    return 0;
  }
  await stores.agentStore.deleteAgent({ tenant_id: scope.tenantId, id: agent.id });
  return 1;
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
          name: MORNING_BRIEF_SCHEDULE_NAME,
          persona_id: null,
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
        name: MORNING_BRIEF_SCHEDULE_NAME,
        manifest: world.scheduleManifest,
        runFrom: now,
      },
      transaction,
    ),
  );
  return 'updated';
}

/**
 * The Tasks space is rewritten unless it already holds this seed day's content, so a re-seed on the same real
 * day with another --today never leaves the old dates behind. A task the assistant ticked is rewritten too.
 */
async function seedSpaces<TTransaction>({
  stores,
  scope,
  world,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
}): Promise<SeedReport['spaces']> {
  const report = { created: 0, updated: 0, unchanged: 0 };
  const owner = { tenant_id: scope.tenantId, created_by: scope.userId };
  for (const space of world.spaces) {
    const { content } = space;
    const existing = await stores.spaceStore.getSpace({ ...owner, space_id: space.id });
    const aggregate = await stores.spaceStore.getAggregate(owner);
    if (existing === undefined) {
      await stores.spaceStore.createSpace({
        ...owner,
        ...content,
        id: space.id,
        expected_aggregate_revision: aggregate.revision,
      });
      report.created += 1;
    } else if (isSameSpaceContent({ stored: existing, wanted: content })) {
      report.unchanged += 1;
    } else {
      await stores.spaceStore.updateSpace({
        ...owner,
        ...content,
        space_id: space.id,
        expected_revision: existing.revision,
        expected_aggregate_revision: aggregate.revision,
      });
      report.updated += 1;
    }
  }
  return report;
}

function isSameSpaceContent({
  stored,
  wanted,
}: {
  stored: DemoSpace['content'];
  wanted: DemoSpace['content'];
}): boolean {
  return (
    stored.name === wanted.name &&
    stored.purpose === wanted.purpose &&
    stored.status === wanted.status &&
    stored.format === wanted.format &&
    stored.body === wanted.body
  );
}

/**
 * Ensures the two connectors the brief needs, through the same steps the server runs at boot, so a seeded
 * demo can read mail and search even when boot never registered them. The mail account itself is the
 * installer's: it holds the app password in its own file, and the seed only registers the endpoint the
 * instance is already configured with. A failure is reported in the seed report, never fatal, as at boot.
 */
async function seedConnectors<TTransaction>({
  stores,
  scope,
  connectors,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  connectors: DemoSeedConnectors;
}): Promise<SeedReport['connectors']> {
  let email: SeedReport['connectors']['email'];
  try {
    email = await registerMailConnector({
      url: connectors.mailUrl,
      mcpServerStore: stores.mcpServerStore,
      tenant_id: scope.tenantId,
    });
  } catch {
    email = 'failed';
  }
  let search: SeedReport['connectors']['search'];
  try {
    search = await seedDefaultSearchProvider({
      globalSettingsStore: stores.globalSettingsStore,
      mcpServerStore: stores.mcpServerStore,
      catalog: connectors.catalog,
      tenant_id: scope.tenantId,
      logger: connectors.logger,
    });
  } catch {
    search = 'failed';
  }
  return { email, search };
}

/** The catalog skill the demo ships enabled, named as the catalog names it. */
const DEMO_SKILL_NAME = 'ten-x';

/**
 * Enables the demo's catalog skill through the same store the Settings screen writes when a person
 * adds it, copying the catalog entry into a skill record exactly as that screen does. A skill the
 * person already has is left as it is, edits and all. Network approval is the person's own act and
 * is never part of the seed. A failure is reported in the seed report, never fatal.
 */
async function seedDemoSkills<TTransaction>({
  stores,
  scope,
  connectors,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  connectors: DemoSeedConnectors;
}): Promise<SeedReport['skills']> {
  try {
    const entry = connectors.skillCatalog.list().find(skill => skill.name === DEMO_SKILL_NAME);
    if (entry === undefined) {
      return { tenX: 'failed' };
    }
    const existing = await stores.skillStore.listSkills({ tenant_id: scope.tenantId, names: [DEMO_SKILL_NAME] });
    if (existing.length > 0) {
      return { tenX: 'already_enabled' };
    }
    const manifest: SkillManifest = {
      type: 'git',
      name: entry.name,
      url: entry.url,
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      ref: entry.ref,
      description: entry.description,
      ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
      ...(entry.network_hosts !== undefined ? { network_hosts: entry.network_hosts } : {}),
    };
    await stores.skillStore.createSkill({ tenant_id: scope.tenantId, name: DEMO_SKILL_NAME, manifest });
    return { tenX: 'enabled' };
  } catch {
    return { tenX: 'failed' };
  }
}

/** Writes (or refreshes) one demo world. Safe to run again: unchanged records are left alone. */
export async function seedDemoWorld<TTransaction>({
  stores,
  scope,
  world,
  now,
  connectors,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
  world: DemoWorld;
  now: Date;
  connectors: DemoSeedConnectors;
}): Promise<SeedReport> {
  await removeEarlierSeeds({ stores, scope });
  const memory = await seedMemory({ memory: stores.memory, notes: world.notes, now });
  const { personas, knowledge } = await seedPersonas({ stores, scope, world });
  const profile = await seedProfile({ stores, scope, world });
  // Connectors first, so the agent can be given the ones this run registered.
  const connectorReport = await seedConnectors({ stores, scope, connectors });
  const agent = await seedAgent({ stores, scope, world });
  const schedule = await seedSchedule({ stores, scope, world, agentId: agent.agentId, now });
  const spaces = await seedSpaces({ stores, scope, world });
  const skillReport = await seedDemoSkills({ stores, scope, connectors });
  return {
    personas,
    profile,
    agent: agent.outcome,
    schedule,
    spaces,
    knowledge,
    memory,
    connectors: connectorReport,
    skills: skillReport,
  };
}

/** Removes only what the seed wrote; everything the user made themselves stays. */
export async function resetDemoWorld<TTransaction>({
  stores,
  scope,
}: {
  stores: DemoSeedStores<TTransaction>;
  scope: DemoSeedScope;
}): Promise<ResetReport> {
  const report: ResetReport = { ...(await removeEarlierSeeds({ stores, scope })), profile: 0, memory: 0 };
  const owner = { tenant_id: scope.tenantId, created_by: scope.userId };

  const schedule = await findSchedule({ stores, scope });
  if (schedule?.created_by_subject.subject_id === scope.userId) {
    await stores.scheduleStore.deleteSchedule({ tenant_id: scope.tenantId, id: schedule.id });
    report.schedule += 1;
  }

  report.agent += await removeAgentWhenUnused({ stores, scope, agentName: DEMO_AGENT_NAME });

  for (const persona of (await stores.personaStore.listPersonas(owner)).filter(candidate => isDemoId(candidate.id))) {
    await stores.personaStore.deletePersona({ ...owner, id: persona.id });
    await stores.knowledge.deleteLibrary({ personaId: persona.id });
    report.personas += 1;
  }

  const profileKey = owner;
  const profile = await stores.personalizationStore.getProfile(profileKey);
  if (profile !== undefined && isSeededProfile(profile.user_profile)) {
    await stores.personalizationStore.deleteProfile(profileKey);
    report.profile += 1;
  }

  const spaces = await stores.spaceStore.listSpaces({ ...owner, status: undefined, limit: SPACE_LIST_LIMIT });
  for (const space of spaces.filter(candidate => isDemoId(candidate.id))) {
    await stores.spaceStore.deleteSpace({ ...owner, space_id: space.id, expected_revision: space.revision });
    report.spaces += 1;
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
