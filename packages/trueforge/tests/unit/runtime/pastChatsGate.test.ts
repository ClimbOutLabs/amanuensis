/**
 * The past-chat search switch at the resolver: while it is off, the turn's tools do not
 * include `search_past_chats` at all; while it is on, the tool is there and reads as a
 * read-only look at the person's own chats.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { MemoryConfig } from '../../../src/runtime/memory/memoryCapability';
import type { MemoryTurnContext, ToolOutputScreenConfig } from '../../../src/runtime/MemoryTurnResourceResolver';
import { SpaceTurnResourceResolver, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

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
  });
}

describe('the past-chat search switch', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  function resolver(enabled: boolean) {
    const sessionStore = new SqliteSessionStore(env.db);
    return new SpaceTurnResourceResolver(
      {
        llm: () =>
          Promise.resolve({
            modelClient: stubModel(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () => Promise.reject(new Error('no connectors in this test')),
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
        sessionStore,
        budget: uncappedTokenFactoryBudget,
        authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
      },
      enabled
        ? {
            sessionStore,
            personaStore: { listPersonas: async () => [] },
            memoryDir: '',
            scope: undefined,
            authority: { tenantId: OWNER.tenant_id, userRef: OWNER.created_by },
          }
        : undefined,
    );
  }

  async function toolSetNames(enabled: boolean): Promise<string[]> {
    const turnResolver = resolver(enabled);
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    });
    return (resolved.extraCapabilities ?? []).flatMap(capability =>
      (capability.systemToolSets ?? []).map(toolSet => toolSet.name),
    );
  }

  it('does not offer the tool while the switch is off', async () => {
    expect(await toolSetNames(false)).not.toContain('past_chats');
  });

  it('offers the tool while the switch is on, as a read-only look', async () => {
    const turnResolver = resolver(true);
    const resolved = await turnResolver.resolveAgentDefinition({
      spec: spec(),
      ...OWNER,
      session_id: 's1',
      signal: new AbortController().signal,
      tracing: turnResolver.createTracing(),
    });
    const toolSets = (resolved.extraCapabilities ?? []).flatMap(capability => capability.systemToolSets ?? []);
    const pastChats = toolSets.find(toolSet => toolSet.name === 'past_chats');
    expect(pastChats).toBeDefined();
    if (pastChats === undefined) {
      return;
    }
    const info = await pastChats.toolCallInfo({ name: 'search_past_chats', arguments: { query: 'ferry' } });
    expect(info.effect).toBe('inspect');
    expect(info.read_only_hint).toBe(true);
    expect(info.destructive_hint).toBe(false);
  });
});
