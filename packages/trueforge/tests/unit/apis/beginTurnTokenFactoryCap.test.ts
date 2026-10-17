import {
  AgentSpecSchema,
  SessionHandle,
  TurnHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType, type ILLM, type ModelMessageEvent } from '@truefoundry/trueforge-core/core';
import type { Server } from 'node:http';
import { createLogger } from 'winston';

import { TENANT_ID } from '../../../src/apis/sessions';
import { beginTurnExecution, drainTurnEvents } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteTokenFactoryUsageStore } from '../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { createTokenFactoryBudget, TokenFactoryDailyCapError } from '../../../src/runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider } from '../../../src/runtime/tokenFactoryProvider';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { startModelEndpointStub } from '../../fixtures/modelEndpointStub';

/** Constructor args of the replaced resolver: the first one carries the `llm` factory the cap guards. */
const mockResolverCtorArgs: unknown[][] = [];

jest.mock('../../../src/runtime/spaceCapability', () => {
  const actual = jest.requireActual('../../../src/runtime/spaceCapability');
  return {
    ...actual,
    SpaceTurnResourceResolver: jest.fn((...args: unknown[]) => {
      mockResolverCtorArgs.push(args);
      return {};
    }),
  };
});

const NOW = new Date();
const CAP = 1000;

function modelMessageWithUsage(usage: { input_tokens: number; output_tokens: number }): ModelMessageEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id: 'msg-1',
    thread_id: 'main',
    created_at: NOW.toISOString(),
    usage: {
      ...usage,
      input_tokens_breakdown: { harness: 0, skills: 0, instructions: 0, tool_definitions: 0, messages: 0 },
    },
  };
}

function isLlmFactory(
  value: unknown,
): value is (
  name: string,
) => Promise<{ modelId: string; modelClient: ILLM; modelProperties?: { contextLength: number | undefined } }> {
  return typeof value === 'function';
}

const DEAD_URL = 'http://127.0.0.1:1/v1';
const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

async function startTurn(options: { cap: number | undefined; tokenFactoryUrl?: string; localUrl?: string }) {
  const logger = createLogger({ silent: true });
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const usageStore = new SqliteTokenFactoryUsageStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  await ensureEnvManagedTokenFactoryProvider({
    store: modelProviderStore,
    tenant_id: TENANT_ID,
    settings: {
      apiKey: 'sk-nebius',
      baseUrl: options.tokenFactoryUrl ?? 'https://api.tokenfactory.nebius.com/v1',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      cheaperModel: undefined,
    },
    logger,
  });
  await modelProviderStore.upsertProvider({
    tenant_id: TENANT_ID,
    name: 'local-vllm',
    manifest: {
      type: 'custom',
      name: 'local-vllm',
      base_url: options.localUrl ?? 'http://127.0.0.1:8000/v1',
      models: [
        { model_id: 'local-model', name: 'local-model', properties: {} },
        { model_id: 'sized-model', name: 'sized-model', properties: { context_length: 32_000 } },
      ],
    },
  });
  const tokenStore = new SqliteOAuthTokenStore(db);
  const sessionStore = new SqliteSessionStore(db);
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: 's1',
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'tokenfactory/nemotron-3-super-120b-a12b' } }),
    },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
  const record = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: 's1' });
  if (record === undefined) {
    throw new Error('test session s1 was never created');
  }
  const handle = new SessionHandle<SessionCustom, TurnCustom>({ store: sessionStore, session: record });
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const turn = TurnHandle.fromRecord<TurnCustom>({
    store: sessionStore,
    turn: {
      turn_id: 'turn-cap',
      session_id: 's1',
      first_turn_id: 'turn-cap',
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'running' },
      input: [],
      snapshot: { threads: {}, mcp_servers: null, sandbox_info: null },
      created_at: createdAt,
      updated_at: createdAt,
      custom: null,
    },
  });
  jest.spyOn(turn, 'stream').mockImplementation(async function* (): AsyncGenerator<TurnStreamingEvent> {});
  jest.spyOn(handle, 'createTurn').mockResolvedValue(turn);

  const { drainInput } = await beginTurnExecution({
    session: handle,
    input: [],
    previous_turn_id: undefined,
    userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
    deps: {
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      tokenFactoryBudget: createTokenFactoryBudget({ store: usageStore, cap: options.cap, now: () => NOW }),
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
      turnDrains: new TurnDrainRegistry(),
      tokenStore,
      agentStore: new SqliteAgentStore(db),
      modelProviderStore,
      mcpServerStore: new McpServerWithAuthStore({
        store: new SqliteMcpServerStore(db),
        tokenStore,
        clientName: 'test-client',
      }),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      skillStore: new SqliteSkillStore(db),
      repositoryStore: new SqliteRepositoryStore(db),
      spaceStore: new SqliteSpaceStore(db),
      turnArtifactStore: new FakeTurnArtifactStore(),
      eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
      logger,
    },
  });
  const llm = mockResolverCtorArgs.at(-1)?.[0];
  const llmFactory = typeof llm === 'object' && llm !== null && 'llm' in llm ? llm.llm : undefined;
  if (!isLlmFactory(llmFactory)) {
    throw new Error('the resolver was not built with an llm factory');
  }
  return { llm: llmFactory, drainInput, usageStore };
}

describe('Token Factory daily cap in the turn path', () => {
  const originalMode = configuration.TOKEN_FACTORY_MODE;
  const originalKey = configuration.NEBIUS_API_KEY;
  const originalBaseUrl = configuration.TOKEN_FACTORY_BASE_URL;
  const servers: Server[] = [];

  beforeEach(() => {
    mockResolverCtorArgs.length = 0;
    configuration.NEBIUS_API_KEY = 'sk-nebius';
  });

  afterEach(() => {
    configuration.TOKEN_FACTORY_MODE = originalMode;
    configuration.NEBIUS_API_KEY = originalKey;
    configuration.TOKEN_FACTORY_BASE_URL = originalBaseUrl;
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function modelServer(usage: { prompt_tokens: number; completion_tokens: number }) {
    const started = await startModelEndpointStub({ usage });
    servers.push(started.server);
    return started.baseUrl;
  }

  async function useUpToday(usageStore: SqliteTokenFactoryUsageStore, tokens: number) {
    await usageStore.addUsage({ usage_date: NOW.toISOString().slice(0, 10), tokens });
  }

  async function usedToday(usageStore: SqliteTokenFactoryUsageStore) {
    return (await usageStore.getUsage({ usage_date: NOW.toISOString().slice(0, 10) }))?.used_tokens;
  }

  it('admits a Token Factory turn under the cap and counts the usage each model call reports', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 300, completion_tokens: 50 });
    const { llm, usageStore } = await startTurn({ cap: CAP, tokenFactoryUrl });

    const { modelClient, modelId } = await llm('tokenfactory/nemotron-3-super-120b-a12b');
    expect(modelId).toBe('nvidia/nemotron-3-super-120b-a12b');
    await modelClient.createNonStream(ask);
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(700);
  });

  it('refuses a new Token Factory turn with the typed error once the cap is reached', async () => {
    const { llm, usageStore } = await startTurn({ cap: CAP });
    await useUpToday(usageStore, CAP);

    await expect(llm('tokenfactory/nemotron-3-super-120b-a12b')).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
  });

  it('stops a running turn before its next model call when the cap is reached mid-turn', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 900, completion_tokens: 200 });
    const { llm, usageStore } = await startTurn({ cap: CAP, tokenFactoryUrl });
    const { modelClient } = await llm('tokenfactory/nemotron-3-super-120b-a12b');

    await modelClient.createNonStream(ask);
    expect(await usedToday(usageStore)).toBe(1100);

    await expect(modelClient.createNonStream(ask)).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
    expect(await usedToday(usageStore)).toBe(1100);
  });

  it('never refuses and never counts a turn on another provider', async () => {
    const localUrl = await modelServer({ prompt_tokens: 300, completion_tokens: 50 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl });
    await useUpToday(usageStore, CAP);

    const { modelClient, modelId } = await llm('local-vllm/local-model');
    expect(modelId).toBe('local-model');
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(CAP);
  });

  it('passes the model context length from its settings so the context guard can run', async () => {
    const { llm } = await startTurn({ cap: undefined });

    expect((await llm('local-vllm/sized-model')).modelProperties).toEqual({ contextLength: 32_000 });
    expect((await llm('local-vllm/local-model')).modelProperties).toEqual({ contextLength: undefined });
  });

  it('applies the cap to a local turn that TOKEN_FACTORY_MODE=force routes to Token Factory', async () => {
    configuration.TOKEN_FACTORY_MODE = 'force';
    const { llm, usageStore } = await startTurn({ cap: CAP });
    await useUpToday(usageStore, CAP);

    await expect(llm('local-vllm/local-model')).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
  });

  it('counts Token Factory traffic that TOKEN_FACTORY_MODE=fallback sends after the local model failed', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl: DEAD_URL });
    const { modelClient } = await llm('local-vllm/local-model');

    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(150);
  });

  it('does not count a fallback-mode call the local model answered itself', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const localUrl = await modelServer({ prompt_tokens: 7, completion_tokens: 3 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl });
    const { modelClient } = await llm('local-vllm/local-model');

    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBeUndefined();
  });

  it('stops using the Token Factory fallback once the cap is reached', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl: DEAD_URL });
    const { modelClient } = await llm('local-vllm/local-model');
    await useUpToday(usageStore, CAP);

    await expect(modelClient.createNonStream(ask)).rejects.toThrow();

    expect(await usedToday(usageStore)).toBe(CAP);
  });

  it('counts through the model calls only, so the turn event drain adds nothing', async () => {
    const { drainInput, usageStore } = await startTurn({ cap: CAP });

    async function* events(): AsyncGenerator<TurnStreamingEvent> {
      yield modelMessageWithUsage({ input_tokens: 300, output_tokens: 50 });
    }
    await drainTurnEvents({ ...drainInput, trackedStream: events() });

    expect(await usedToday(usageStore)).toBeUndefined();
  });

  it('has no cap when the variable is unset', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 9_000_000, completion_tokens: 1 });
    const { llm, usageStore } = await startTurn({ cap: undefined, tokenFactoryUrl });

    const { modelClient } = await llm('tokenfactory/nemotron-3-super-120b-a12b');
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBeUndefined();
  });
});
