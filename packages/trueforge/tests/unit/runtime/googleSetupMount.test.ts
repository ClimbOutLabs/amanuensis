/**
 * The guided Google setup, mounted by the real turn resolver: a person whose login is missing or partial
 * gets the setup read in their chat, so the assistant can lead the setup from there. A person whose login
 * already allows everything gets nothing, and no other person's state leaks into the turn.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { createLogger } from 'winston';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { startInertMcpServer, type InertMcpServer } from '../../fixtures/inertMcpServer';
import { installRecordedMail } from '../../fixtures/recordedMail';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';
import { noSpaceFolders } from './spaceFolderStoreFake';

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const OWNER = { tenant_id: 't1', created_by: 'u1' };

const MEMORY_CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: false, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: false, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};
const NO_SCREEN: ToolOutputScreenConfig = { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500 };
const memory: MemoryTurnContext = {
  client: undefined,
  config: MEMORY_CONFIG,
  sessionId: 's1',
  previousTurnId: null,
  summarize: undefined,
  providerServerName: undefined,
};

const STORE: SpaceToolStore = {
  createSpace: jest.fn(),
  updateSpace: jest.fn(),
  revertSpace: jest.fn(),
  listSpacesWithAggregate: jest.fn(),
  getSpace: jest.fn(),
  ...noSpaceFolders,
  getSpaceRevision: jest.fn(),
};

function stubModel(): ILLM {
  return {
    create: () =>
      (async function* () {
        await Promise.resolve();
        yield {
          id: 'chunk-1',
          object: 'chat.completion.chunk' as const,
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' as const, content: 'ok' }, finish_reason: 'stop' as const }],
        };
        return {
          output: { role: 'assistant' as const, content: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: 'stop' as const,
        };
      })(),
    createNonStream: () => Promise.reject(new Error('unused')),
  };
}

function spec(): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'scripted/chat-model' },
    instructions: 'Answer the user.',
    mcp_servers: [{ name: 'finder' }],
  });
}

function record(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'test-secret-value',
    client_type: 'desktop',
    refresh_token: 'refresh-token',
    granted_scopes: [READ],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('the guided Google setup mount', () => {
  let inert: InertMcpServer;
  let env: SqliteTestDatabase;
  let connections: SqliteGoogleConnectionStore;
  let mailFetch: ReturnType<typeof installRecordedMail>;

  beforeAll(async () => {
    inert = await startInertMcpServer({ webSearch: true });
  });
  afterAll(async () => {
    await inert.close();
  });
  beforeEach(() => {
    mailFetch = installRecordedMail();
  });
  afterEach(() => {
    mailFetch.restore();
  });
  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    connections = new SqliteGoogleConnectionStore(env.db);
  }, 120_000);
  afterEach(async () => {
    await env.teardown();
  });

  function resolver() {
    return new SpaceTurnResourceResolver(
      {
        llm: () =>
          Promise.resolve({
            modelClient: stubModel(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () =>
          Promise.resolve({ url: inert.url, headers: {}, search_provider: { tools: [], plumbing_fields: [] } }),
        mcpRequestTimeoutMs: 10_000,
        mcpConnectTimeoutMs: 10_000,
        logger: createLogger({ silent: true }),
      },
      undefined,
      undefined,
      memory,
      NO_SCREEN,
      undefined,
      undefined,
      undefined,
      {
        store: STORE,
        googleConnections: connections,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
        sessionId: 's1',
        logger: createLogger({ silent: true }),
        startsAnswer: true,
      },
      {
        store: new FakeTurnArtifactStore(),
        tenantId: OWNER.tenant_id,
        sessionId: 's1',
        turnId: 't1',
        logger: createLogger({ silent: true }),
      },
      {
        sessionStore: new SqliteSessionStore(env.db),
        budget: uncappedTokenFactoryBudget,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
      },
    );
  }

  async function resolved() {
    const turnResolver = resolver();
    return turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    });
  }

  async function setupCapabilityOf(
    definition: Awaited<ReturnType<typeof resolved>>,
  ): Promise<{ tools: string[]; instructionBuilders: number } | undefined> {
    for (const capability of definition.extraCapabilities ?? []) {
      for (const set of capability.systemToolSets ?? []) {
        if (set.name !== 'google_setup') {
          continue;
        }
        const listed = await set.listTools();
        const tools = 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
        return { tools, instructionBuilders: (capability.instructionBuilders ?? []).length };
      }
    }
    return undefined;
  }

  it('mounts the setup read and its guidance for a person who never connected', async () => {
    const mounted = await setupCapabilityOf(await resolved());
    expect(mounted?.tools).toEqual(['google_setup_status']);
    expect(mounted?.instructionBuilders).toBe(1);
  });

  it('still mounts it when the login allows only some of mail and calendar', async () => {
    await connections.save(record({ granted_scopes: [READ, COMPOSE] }));
    const mounted = await setupCapabilityOf(await resolved());
    expect(mounted?.tools).toEqual(['google_setup_status']);
  });

  it('mounts nothing once the login allows everything', async () => {
    await connections.save(record({ granted_scopes: [READ, COMPOSE, CALENDAR_READ, CALENDAR_WRITE] }));
    expect(await setupCapabilityOf(await resolved())).toBeUndefined();
  });
});
