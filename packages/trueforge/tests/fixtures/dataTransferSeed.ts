/**
 * Seeds a rich, deterministic source instance for data export/import tests:
 * folders, chats (multi-turn, compacted, schedule-born, one left running),
 * personas with knowledge, a profile, a two-revision space, schedules,
 * connectors of every auth kind, settings, and Markdown memory with a
 * tombstone. Invented data only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentSpecSchema, MAIN_THREAD_ID, type SessionMetrics } from '@truefoundry/trueforge-core/agent-session';
import { ContextCompactionEventSchema, ThreadOverwriteContextEventSchema } from '@truefoundry/trueforge-core/core';
import {
  makeCreateTurnInput,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnCreatedEvent,
} from '../../../trueforge-core/tests/agent-session/testHelpers';

import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { IAgentStore } from '../../src/db/agentStore';
import type { IGlobalSettingsStore } from '../../src/db/globalSettingsStore';
import type { IMcpServerStore } from '../../src/db/mcpServerStore';
import type { IModelProviderStore } from '../../src/db/modelProviderStore';
import type { IPersonaStore } from '../../src/db/personaStore';
import type { IPersonalizationStore } from '../../src/db/personalizationStore';
import type { IScheduleStore } from '../../src/db/scheduleStore';
import type { ISentinelAuditStore } from '../../src/db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../../src/db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../../src/db/sessionCustom';
import type { ISpaceStore } from '../../src/db/spaceStore';
import type { ITurnArtifactStore } from '../../src/db/turnArtifactStore';
import { personaKnowledgeLocation } from '../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../src/personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../../src/runtime/memory/embeddingModel';
import { McpServerManifestSchema } from '../../src/schemas/mcpServer';
import { ScheduleManifestSchema } from '../../src/schemas/schedule';

export const SEED_IDS = {
  folder: 'folder-1',
  sessionMain: 'session-1',
  sessionScheduled: 'session-2',
  sessionRunning: 'session-3',
  personaResearcher: 'persona-researcher',
  personaChef: 'persona-chef',
  space: 'space-1',
  scheduleDaily: 'schedule-1',
  scheduleWeekly: 'schedule-2',
  agentName: 'reporter',
} as const;

/**
 * The dates and totals the seeded chats are given after creation, so a
 * round trip can prove they come back instead of being re-stamped "now".
 */
interface SeedChatHistory {
  created_at: string;
  updated_at: string;
  last_activity_timestamp_ms: number;
  metrics: SessionMetrics;
  turns: Record<string, { created_at: string; updated_at: string }>;
}

export const SEED_HISTORY: Record<string, SeedChatHistory> = {
  [SEED_IDS.sessionMain]: {
    created_at: '2026-09-01T08:00:00.000Z',
    updated_at: '2026-09-03T18:30:00.000Z',
    last_activity_timestamp_ms: Date.parse('2026-09-03T18:30:00.000Z'),
    metrics: { total_duration_ms: 91_000, total_turns: 3, total_cost_in_usd: 0.42 },
    turns: {
      'session-1-turn-1': { created_at: '2026-09-01T08:00:05.000Z', updated_at: '2026-09-01T08:00:40.000Z' },
      'session-1-turn-2': { created_at: '2026-09-02T09:00:00.000Z', updated_at: '2026-09-02T09:00:30.000Z' },
      'session-1-turn-3': { created_at: '2026-09-03T18:29:00.000Z', updated_at: '2026-09-03T18:30:00.000Z' },
    },
  },
  [SEED_IDS.sessionScheduled]: {
    created_at: '2026-09-10T06:00:00.000Z',
    updated_at: '2026-09-10T06:01:00.000Z',
    last_activity_timestamp_ms: Date.parse('2026-09-10T06:01:00.000Z'),
    metrics: { total_duration_ms: 20_000, total_turns: 1 },
    turns: {
      'session-2-turn-1': { created_at: '2026-09-10T06:00:10.000Z', updated_at: '2026-09-10T06:01:00.000Z' },
    },
  },
  [SEED_IDS.sessionRunning]: {
    created_at: '2026-09-12T12:00:00.000Z',
    updated_at: '2026-09-12T12:00:05.000Z',
    last_activity_timestamp_ms: Date.parse('2026-09-12T12:00:05.000Z'),
    metrics: { total_duration_ms: 0, total_turns: 1 },
    turns: {
      'session-3-turn-1': { created_at: '2026-09-12T12:00:01.000Z', updated_at: '2026-09-12T12:00:05.000Z' },
    },
  },
};

export const SEED_DEFAULT_CHAT_MODEL = 'source-host/chat-model';

/** Permission history of the seeded owner, with the dates the source recorded. */
export const SEED_AUDIT = [
  {
    id: 'audit-1',
    conversation_id: SEED_IDS.sessionMain,
    tier: 3,
    tool_name: 'reporter-server__send_report',
    description: 'Send the report to the team.',
    outcome: 'approved',
    auto_deny_reason: null,
    created_at: '2026-09-01T08:00:20.000Z',
  },
  {
    id: 'audit-2',
    conversation_id: SEED_IDS.sessionMain,
    tier: 2,
    tool_name: 'reporter-server__search',
    description: 'Search the web.',
    outcome: 'denied',
    auto_deny_reason: null,
    created_at: '2026-09-02T09:00:10.000Z',
  },
  {
    id: 'audit-3',
    conversation_id: '',
    tier: 1,
    tool_name: 'data_export',
    description: 'Exported an earlier copy.',
    outcome: 'logged',
    auto_deny_reason: null,
    created_at: '2026-09-04T10:00:00.000Z',
  },
] as const;

/** Persona choices made in the seeded main chat, oldest first. */
export const SEED_PERSONA_ACTIVATIONS = [
  { id: 'activation-1', turn_id: null, persona_id: SEED_IDS.personaChef, persona_name: 'Chef', source: 'explicit' },
  {
    id: 'activation-2',
    turn_id: 'session-1-turn-2',
    persona_id: SEED_IDS.personaResearcher,
    persona_name: 'Researcher',
    source: 'invocation',
  },
] as const;

export const SEED_MEMORY = {
  curated: '# About\n\nPrefers dark mode and short answers.',
  keptEntryTimestamp: '2026-10-01T09:00:00.000Z',
  keptEntryText: 'Likes tea in the morning.',
  deletedEntryTimestamp: '2026-10-01T10:00:00.000Z',
  personaEntryTimestamp: '2026-10-02T08:00:00.000Z',
  personaEntryText: 'Researcher keeps sources cited.',
} as const;

export interface DataTransferSeedStores<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  agentStore: IAgentStore<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  auditStore: ISentinelAuditStore;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  modelProviderStore: IModelProviderStore<TTransaction>;
}

export interface SeedRichInstanceInput<TTransaction> {
  stores: DataTransferSeedStores<TTransaction>;
  tenantId: string;
  userId: string;
  memoryDir: string;
  knowledgeDir: string;
}

function subject(userId: string) {
  return { subject_id: userId, subject_type: 'user' as const, subject_display_name: userId };
}

async function finishTurn(
  store: ISessionStore<SessionCustom, TurnCustom>,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const state = makeDoneTurnState();
  await store.updateTurnState({
    session_id: sessionId,
    turn_id: turnId,
    state,
    turn_done_event: {
      type: 'turn.done',
      id: `done-${turnId}`,
      created_at: state.completed_at,
      state,
      thread_id: null,
    },
  });
}

export async function seedRichInstance<TTransaction>(input: SeedRichInstanceInput<TTransaction>): Promise<void> {
  const { stores, tenantId, userId } = input;
  const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' });

  const agent = await stores.agentStore.createAgent({
    host_managed: false,
    tenant_id: tenantId,
    created_by_subject: subject(userId),
    name: SEED_IDS.agentName,
    description: 'Writes the digest.',
    manifest: agentSpec,
    external_id: null,
  });

  const dailyManifest = ScheduleManifestSchema.parse({
    task: 'Write the morning digest',
    cron: '0 8 * * *',
    timezone: 'UTC',
    status: 'active',
  });
  await stores.scheduleStore.createScheduleAndRun({
    id: SEED_IDS.scheduleDaily,
    tenant_id: tenantId,
    agent_id: agent.id,
    agent_name: SEED_IDS.agentName,
    persona_id: null,
    name: 'Daily digest',
    manifest: dailyManifest,
    created_by_subject: subject(userId),
    runFrom: new Date('2026-10-16T00:00:00.000Z'),
  });
  await stores.scheduleStore.createScheduleAndRun({
    id: SEED_IDS.scheduleWeekly,
    tenant_id: tenantId,
    agent_id: agent.id,
    agent_name: SEED_IDS.agentName,
    persona_id: null,
    name: 'Weekly review',
    manifest: ScheduleManifestSchema.parse({
      task: 'Write the weekly review',
      cron: '0 9 * * 1',
      timezone: 'UTC',
      status: 'paused',
    }),
    created_by_subject: subject(userId),
    runFrom: new Date('2026-10-16T00:00:00.000Z'),
  });

  await stores.sessionStore.createSessionFolder({
    tenant_id: tenantId,
    folder_id: SEED_IDS.folder,
    created_by: userId,
    name: 'Research',
  });

  // Main chat: three turns, the third behind a compaction overwrite, in a folder.
  await stores.sessionStore.createSession({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionMain,
    created_by_subject: subject(userId),
    agent: { type: 'inline', spec: agentSpec },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await stores.sessionStore.setSessionFolder({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionMain,
    created_by: userId,
    folder_id: SEED_IDS.folder,
  });
  await stores.sessionStore.createTurn(
    makeCreateTurnInput({
      sessionId: SEED_IDS.sessionMain,
      turnId: 'session-1-turn-1',
      approval_grants: ['reporter-server:search'],
      update_session_title_if_not_exist: 'First chat',
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [
            { role: 'user', content: 'What is the capital of France?' },
            { role: 'assistant', content: 'Paris.' },
          ],
          current_context_usage: { prompt_tokens: 11, completion_tokens: 2 },
        },
      ],
    }),
  );
  await stores.sessionStore.appendToEvents({
    session_id: SEED_IDS.sessionMain,
    turn_id: 'session-1-turn-1',
    events: [makeTurnCreatedEvent('session-1-turn-1'), makeModelMessageEvent()],
  });
  await stores.turnArtifactStore.recordStoredArtifact({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionMain,
    turn_id: 'session-1-turn-1',
    path: 'notes.txt',
    name: 'notes.txt',
    data: Buffer.from('hello artifact'),
    mime: 'text/plain',
  });
  await finishTurn(stores.sessionStore, SEED_IDS.sessionMain, 'session-1-turn-1');

  await stores.sessionStore.createTurn(
    makeCreateTurnInput({
      sessionId: SEED_IDS.sessionMain,
      turnId: 'session-1-turn-2',
      previousTurnId: 'session-1-turn-1',
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [
            { role: 'user', content: 'And of Spain?' },
            { role: 'assistant', content: 'Madrid.' },
          ],
          current_context_usage: { prompt_tokens: 20, completion_tokens: 2 },
        },
      ],
    }),
  );
  await stores.sessionStore.appendToEvents({
    session_id: SEED_IDS.sessionMain,
    turn_id: 'session-1-turn-2',
    events: [makeTurnCreatedEvent('session-1-turn-2'), makeModelMessageEvent()],
  });
  await finishTurn(stores.sessionStore, SEED_IDS.sessionMain, 'session-1-turn-2');

  await stores.sessionStore.createTurn(
    makeCreateTurnInput({
      sessionId: SEED_IDS.sessionMain,
      turnId: 'session-1-turn-3',
      previousTurnId: 'session-1-turn-2',
      new_context_appends: [],
    }),
  );
  const overwriteEvent = ThreadOverwriteContextEventSchema.parse({
    type: 'agent.context.overwrite',
    id: 'overwrite-session-1-turn-3',
    created_at: '2026-10-16T10:00:00.000Z',
    thread_id: MAIN_THREAD_ID,
    reason: 'compaction',
    context: [
      { role: 'user', content: 'Summary: capitals of France and Spain.' },
      { role: 'assistant', content: 'Understood.' },
    ],
    current_context_usage: { prompt_tokens: 9, completion_tokens: 2 },
    usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
  });
  await stores.sessionStore.overwriteThreadContext({
    session_id: SEED_IDS.sessionMain,
    turn_id: 'session-1-turn-3',
    event: overwriteEvent,
  });
  // The overwrite event itself is not part of the persisted stream; the
  // durable record of a compaction is the compaction event.
  const compactionEvent = ContextCompactionEventSchema.parse({
    type: 'agent.context.compaction',
    id: 'compaction-session-1-turn-3',
    created_at: '2026-10-16T10:00:00.000Z',
    thread_id: MAIN_THREAD_ID,
    mode: 'conversation',
    tokens_before: 22,
    tokens_after: 11,
    summary_chars: 38,
    outcome: 'applied',
  });
  await stores.sessionStore.appendToEvents({
    session_id: SEED_IDS.sessionMain,
    turn_id: 'session-1-turn-3',
    events: [makeTurnCreatedEvent('session-1-turn-3'), compactionEvent, makeModelMessageEvent()],
  });
  await finishTurn(stores.sessionStore, SEED_IDS.sessionMain, 'session-1-turn-3');

  await stores.sessionStore.replaceTaskChecklist({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionMain,
    expected_revision: 0,
    items: [
      { id: 'item-1', text: 'Book flights', done: true },
      { id: 'item-2', text: 'Reserve hotel', done: false },
    ],
  });

  // Schedule-born chat bound to the named agent by reference.
  await stores.sessionStore.createSession({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionScheduled,
    created_by_subject: subject(userId),
    agent: { type: 'reference', id: agent.id, name: SEED_IDS.agentName },
    custom: null,
    metadata: {},
    external_id: null,
    source: { type: 'schedule', id: SEED_IDS.scheduleDaily, run_id: 'run-1' },
  });
  await stores.sessionStore.createTurn(
    makeCreateTurnInput({
      sessionId: SEED_IDS.sessionScheduled,
      turnId: 'session-2-turn-1',
      update_session_title_if_not_exist: 'Morning digest',
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [
            { role: 'user', content: 'Write the digest.' },
            { role: 'assistant', content: 'Here is the digest.' },
          ],
          current_context_usage: { prompt_tokens: 8, completion_tokens: 4 },
        },
      ],
    }),
  );
  await stores.sessionStore.appendToEvents({
    session_id: SEED_IDS.sessionScheduled,
    turn_id: 'session-2-turn-1',
    events: [makeTurnCreatedEvent('session-2-turn-1'), makeModelMessageEvent()],
  });
  await finishTurn(stores.sessionStore, SEED_IDS.sessionScheduled, 'session-2-turn-1');

  // A chat whose turn was still running when the export was taken.
  await stores.sessionStore.createSession({
    tenant_id: tenantId,
    session_id: SEED_IDS.sessionRunning,
    created_by_subject: subject(userId),
    agent: { type: 'inline', spec: agentSpec },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  await stores.sessionStore.createTurn(
    makeCreateTurnInput({
      sessionId: SEED_IDS.sessionRunning,
      turnId: 'session-3-turn-1',
      update_session_title_if_not_exist: 'Unfinished chat',
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [{ role: 'user', content: 'Start something long.' }],
          current_context_usage: { prompt_tokens: 5, completion_tokens: 0 },
        },
      ],
    }),
  );
  await stores.sessionStore.appendToEvents({
    session_id: SEED_IDS.sessionRunning,
    turn_id: 'session-3-turn-1',
    events: [makeTurnCreatedEvent('session-3-turn-1'), makeModelMessageEvent()],
  });

  // Backdate the chats the way a real archive's dates differ from "now".
  for (const [sessionId, history] of Object.entries(SEED_HISTORY)) {
    await stores.sessionStore.stampImportedSession({
      tenant_id: tenantId,
      session_id: sessionId,
      created_at: new Date(history.created_at),
      updated_at: new Date(history.updated_at),
      last_activity_timestamp_ms: history.last_activity_timestamp_ms,
      metrics: history.metrics,
      turns: Object.entries(history.turns).map(([turnId, turn]) => ({
        turn_id: turnId,
        created_at: new Date(turn.created_at),
        updated_at: new Date(turn.updated_at),
      })),
    });
  }

  await stores.personaStore.createPersona({
    tenant_id: tenantId,
    created_by: userId,
    id: SEED_IDS.personaResearcher,
    display_name: 'Researcher',
    aliases: ['Deep dive'],
    instructions: 'Research carefully and cite sources.',
    model_name: 'test-provider/test-model',
    updated_by: userId,
  });
  await stores.personaStore.createPersona({
    tenant_id: tenantId,
    created_by: userId,
    id: SEED_IDS.personaChef,
    display_name: 'Chef',
    aliases: [],
    instructions: 'Cook simply.',
    model_name: 'test-provider/test-model',
    updated_by: userId,
  });

  for (const activation of SEED_PERSONA_ACTIVATIONS) {
    await stores.personaStore.recordPersonaActivation({
      tenant_id: tenantId,
      session_id: SEED_IDS.sessionMain,
      ...activation,
      model_name: 'test-provider/test-model',
    });
  }
  await stores.auditStore.importRecords({ tenant_id: tenantId, created_by: userId, records: SEED_AUDIT });

  const knowledgeDbPath = personaKnowledgeLocation({
    knowledgeDir: input.knowledgeDir,
    tenantId,
    personaId: SEED_IDS.personaResearcher,
  }).dbPath;
  await mkdir(join(input.knowledgeDir, tenantId), { recursive: true });
  const repository = openPersonaKnowledgeRepository({ dbPath: knowledgeDbPath });
  try {
    const notes = repository.createDocument({
      title: 'Field notes',
      titleExplicit: true,
      source_kind: 'upload',
      source_label: 'notes.md',
      source_url: null,
    });
    repository.setDocumentChunks({
      documentId: notes.id,
      chunks: [
        { text: 'First chunk of field notes.', embedding: new Float32Array(EMBEDDING_DIMENSIONS) },
        { text: 'Second chunk of field notes.', embedding: new Float32Array(EMBEDDING_DIMENSIONS) },
      ],
    });
    repository.updateDocumentStatus({ documentId: notes.id, status: 'ready' });
    const page = repository.createDocument({
      title: 'Reference page',
      titleExplicit: false,
      source_kind: 'url',
      source_label: 'Example',
      source_url: 'https://example.com/reference',
    });
    repository.setDocumentChunks({
      documentId: page.id,
      chunks: [{ text: 'Only chunk of the reference page.', embedding: new Float32Array(EMBEDDING_DIMENSIONS) }],
    });
    repository.updateDocumentStatus({ documentId: page.id, status: 'ready' });
  } finally {
    repository.close();
  }

  await stores.personalizationStore.upsertProfile({
    tenant_id: tenantId,
    created_by: userId,
    assistant_name: 'Aman',
    assistant_identity: 'A helpful local assistant.',
    voice_guidance: 'Warm and brief.',
    user_name: null,
    address_as: null,
    user_profile: 'Lives in two time zones.',
    pinned_preferences: ['Answer concisely.'],
    help_areas: [],
    learned_profile: null,
    learning_enabled: true,
    updated_by: userId,
    expected_revision: null,
  });

  const aggregateBefore = await stores.spaceStore.getAggregate({ tenant_id: tenantId, created_by: userId });
  await stores.spaceStore.createSpace({
    tenant_id: tenantId,
    created_by: userId,
    id: SEED_IDS.space,
    name: 'Trip plan',
    purpose: 'Plan the move',
    status: 'active',
    body: 'Draft one.',
    format: 'markdown',
    expected_aggregate_revision: aggregateBefore.revision,
  });
  const aggregateAfterCreate = await stores.spaceStore.getAggregate({ tenant_id: tenantId, created_by: userId });
  await stores.spaceStore.updateSpace({
    tenant_id: tenantId,
    created_by: userId,
    space_id: SEED_IDS.space,
    name: 'Trip plan',
    purpose: 'Plan the move',
    status: 'active',
    body: 'Draft two.',
    format: 'markdown',
    expected_revision: 1,
    expected_aggregate_revision: aggregateAfterCreate.revision,
  });

  await stores.mcpServerStore.createServer({
    tenant_id: tenantId,
    name: 'dcr-connector',
    first_party: false,
    manifest: McpServerManifestSchema.parse({
      type: 'remote',
      name: 'dcr-connector',
      description: 'Signs in with dynamic client registration.',
      url: 'https://dcr.example.com/mcp',
      auth: { type: 'dcr' },
    }),
  });
  await stores.mcpServerStore.createServer({
    tenant_id: tenantId,
    name: 'header-connector',
    first_party: false,
    manifest: McpServerManifestSchema.parse({
      type: 'remote',
      name: 'header-connector',
      description: 'Signs in with a header key.',
      url: 'https://header.example.com/mcp',
      auth: { type: 'header', headers: { Authorization: 'Bearer sk-secret-header-value' } },
    }),
  });
  await stores.mcpServerStore.createServer({
    tenant_id: tenantId,
    name: 'plain-connector',
    first_party: true,
    manifest: McpServerManifestSchema.parse({
      type: 'remote',
      name: 'plain-connector',
      description: 'Needs no sign-in.',
      url: 'https://plain.example.com/mcp',
    }),
  });

  await stores.globalSettingsStore.setSetting({ key: 'default_chat_model', value: SEED_DEFAULT_CHAT_MODEL });
  await stores.globalSettingsStore.setSetting({ key: 'memory_summarize_enabled', value: 'true' });
  await stores.globalSettingsStore.setSetting({ key: 'tool_output_screen_enabled', value: 'true' });
  await stores.globalSettingsStore.setSetting({ key: 'memory_screen_enabled', value: 'false' });
  await stores.sentinelSettingsStore.patch({
    tenant_id: tenantId,
    created_by: userId,
    offline_mode: true,
    tier2_auto_allow: ['file_write'],
    search_without_asking: true,
    maps_without_asking: true,
  });

  const baseVault = join(input.memoryDir, tenantId);
  await mkdir(join(baseVault, 'memory'), { recursive: true });
  await writeFile(join(baseVault, 'MEMORY.md'), `${SEED_MEMORY.curated}\n`, 'utf8');
  await writeFile(
    join(baseVault, 'memory', '2026-10-01.md'),
    `## ${SEED_MEMORY.keptEntryTimestamp}\n\n${SEED_MEMORY.keptEntryText}\n\n## ${SEED_MEMORY.deletedEntryTimestamp}\n\nWorks on a train book project.\n\n> From a long chat\n`,
    'utf8',
  );
  await writeFile(
    join(baseVault, '.vault-tombstones.md'),
    `## 2026-10-02T00:00:00.000Z\n\n> vault-entry md:${tenantId}:2026-10-01.md#1 deleted\n`,
    'utf8',
  );
  const personaVault = join(input.memoryDir, `${tenantId}__persona_Researcher`);
  await mkdir(join(personaVault, 'memory'), { recursive: true });
  await writeFile(
    join(personaVault, 'memory', '2026-10-02.md'),
    `## ${SEED_MEMORY.personaEntryTimestamp}\n\n${SEED_MEMORY.personaEntryText}\n`,
    'utf8',
  );
}
