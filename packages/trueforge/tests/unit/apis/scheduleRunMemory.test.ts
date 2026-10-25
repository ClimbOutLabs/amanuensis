/**
 * A scheduled run must start its turn with the same memory wiring as a chat turn.
 *
 * Without a memory client, the turn engine resolves no summarization context and the
 * drain retains nothing, so a scheduled agent's turns are never summarized and never
 * reach the Memories page. These tests drive a real schedule run (only the turn start
 * is mocked out) and check the client the run hands to the turn: it exists, it writes
 * into the vault the Memories page reads for that agent, and with it present the
 * summarization context resolves.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import winston from 'winston';
import { createSchedulesRouter } from '../../../src/apis/schedules';
import { startTurnInProcess } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import type { RequestContext } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import configuration from '../../../src/config';
import { BriefItemCompletionStore } from '../../../src/db/briefItemCompletionStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import type { Persona } from '../../../src/personas/persona';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import { resolveTurnSummarizeContext } from '../../../src/runtime/memorySummarizeSettings';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../src/apis/turns', () => {
  const actual = jest.requireActual<typeof import('../../../src/apis/turns')>('../../../src/apis/turns');
  return { ...actual, startTurnInProcess: jest.fn() };
});

const mockedStartTurnInProcess = jest.mocked(startTurnInProcess);

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};

const ZARA: Persona = {
  tenant_id: 'default',
  id: 'p-zara',
  created_by: 'alice',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  updated_by: 'alice',
  display_name: 'Zara',
  aliases: [],
  instructions: 'Answer as a careful archivist.',
  model_name: 'test-provider/test-model',
};

/** Minimal fake; resolving a summarization context never dereferences the store. */
function fakeModelProviderStore(): IModelProviderStore {
  return {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
}

describe('scheduled run memory wiring', () => {
  const originalBackend = configuration.MEMORY_BACKEND;
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  const originalEmbeddings = configuration.MEMORY_EMBEDDINGS_ENABLED;
  const originalSummarize = configuration.MEMORY_SUMMARIZE;
  let baseDir: string;

  beforeEach(async () => {
    mockedStartTurnInProcess.mockReset();
    baseDir = await mkdtemp(join(tmpdir(), 'schedule-run-memory-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = baseDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = false;
    configuration.MEMORY_SUMMARIZE = true;
  });

  afterEach(async () => {
    configuration.MEMORY_BACKEND = originalBackend;
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    configuration.MEMORY_EMBEDDINGS_ENABLED = originalEmbeddings;
    configuration.MEMORY_SUMMARIZE = originalSummarize;
    await rm(baseDir, { recursive: true, force: true });
  });

  async function runScheduleNow(persona: Persona | undefined) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const agentStore = new SqliteAgentStore(db);
    const scheduleStore = new SqliteScheduleStore(db);
    const agent = await agentStore.createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      name: 'reporter',
      description: 'Test agent.',
      manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
      external_id: 'reporter-external-id',
    });
    const { schedule } = await scheduleStore.createScheduleAndRun({
      tenant_id: 'default',
      agent_id: agent.id,
      agent_name: 'reporter',
      name: 'daily-report',
      persona_id: persona?.id ?? null,
      manifest: ScheduleManifestSchema.parse({ task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC', status: 'active' }),
      created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
      runFrom: new Date(),
    });

    const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
    const app = new OpenAPIHono();
    app.route(
      '/',
      createSchedulesRouter({
        mcpCatalog: McpCatalog.loadShipped(),
        scheduleStore,
        briefItemStore: new BriefItemCompletionStore(db),
        sessions: new Sessions<SessionCustom, TurnCustom>({ sessionStore }),
        agentStore,
        personaStore: {
          getPersona: input => Promise.resolve(persona !== undefined && input.id === persona.id ? persona : undefined),
        },
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
        resolveAgentStore: () => agentStore,
        withTransaction: callback => db.transaction().execute(callback),
        resolveRequestContext: () => ALICE,
        authorizer: new TrueForgeAuthorizer(),
      }),
    );

    const response = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule_id: schedule.id }),
    });
    expect(response.status).toBe(201);
    expect(mockedStartTurnInProcess).toHaveBeenCalledTimes(1);
    const params = mockedStartTurnInProcess.mock.calls[0]?.[0];
    if (params === undefined) {
      throw new Error('the scheduled run never reached the turn start');
    }
    return { params, db, agentStore };
  }

  it('hands the turn a memory client that writes into the shared vault the Memories page reads', async () => {
    const { params } = await runScheduleNow(undefined);

    const memoryClient = params.deps.memoryClient;
    expect(memoryClient).toBeDefined();
    if (memoryClient === undefined) {
      return;
    }
    const retained = await memoryClient.retain({
      items: [
        {
          content: 'Turn summary: the scheduled report run finished.',
          timestamp: '2026-10-20T13:00:00.000Z',
          document_id: 'schedule-run-1',
        },
      ],
      operationId: 'schedule-run-op-1',
      timeoutMs: 5_000,
    });
    expect(retained.ok).toBe(true);

    const reader = new MarkdownMemoryClient({ baseDir, namespace: 'default' });
    const shared = await reader.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(shared.ok).toBe(true);
    if (shared.ok) {
      expect(shared.entries.some(entry => entry.text.includes('Turn summary:'))).toBe(true);
    }
  });

  it('scopes a persona schedule’s memory client to that persona’s vault, never the shared one', async () => {
    const { params } = await runScheduleNow(ZARA);

    const memoryClient = params.deps.memoryClient;
    expect(memoryClient).toBeDefined();
    if (memoryClient === undefined) {
      return;
    }
    const retained = await memoryClient.retain({
      items: [
        {
          content: 'Turn summary: Zara’s scheduled archive check finished.',
          timestamp: '2026-10-20T13:00:00.000Z',
          document_id: 'schedule-run-2',
        },
      ],
      operationId: 'schedule-run-op-2',
      timeoutMs: 5_000,
    });
    expect(retained.ok).toBe(true);

    const reader = new MarkdownMemoryClient({ baseDir, namespace: 'default' });
    const zara = await reader.listEntries({ namespace: 'persona:Zara', timeoutMs: 5_000 });
    expect(zara.ok).toBe(true);
    if (zara.ok) {
      expect(zara.entries.some(entry => entry.text.includes('Turn summary:'))).toBe(true);
    }
    const shared = await reader.listEntries({ namespace: '', timeoutMs: 5_000 });
    expect(shared.ok).toBe(true);
    if (shared.ok) {
      expect(shared.entries).toHaveLength(0);
    }
  });

  it('resolves a summarization context for the run once a memory client is present', async () => {
    const { params, db, agentStore } = await runScheduleNow(undefined);
    const base = {
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      logger: winston.createLogger({ silent: true }),
      sessionId: 'schedule-session',
      tenantId: 'default',
      modelProviderStore: fakeModelProviderStore(),
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      modelUsage: discardedModelUsage,
      agentStore,
      personaModelName: undefined,
      sessionAgent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
      } as const,
      helperFqn: undefined,
    };

    // The state a scheduled run was in before the wiring: no client, no context, the
    // summary job never starts.
    expect(await resolveTurnSummarizeContext({ ...base, memoryClientPresent: false })).toBeUndefined();
    // With the client the run now carries, the context resolves and the job can run.
    expect(
      await resolveTurnSummarizeContext({ ...base, memoryClientPresent: params.deps.memoryClient !== undefined }),
    ).toBeDefined();
  });
});
