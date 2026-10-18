import {
  AgentSpecSchema,
  EventType as SessionEventType,
  SessionHandle,
  TurnHandle,
  type TurnModelRole,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { EventType, type ILLM, type ModelMessageEvent } from '@truefoundry/trueforge-core/core';
import type { Server } from 'node:http';
import { createLogger } from 'winston';

import { TENANT_ID } from '../../../src/apis/sessions';
import { beginTurnExecution, drainTurnEvents } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
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
import type { ModelUsagePersistedEvent } from '../../../src/schemas/modelUsageEvents';
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
): value is (name: string, role: TurnModelRole) => Promise<{ modelId: string; modelClient: ILLM }> {
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
      models: [{ model_id: 'local-model', name: 'local-model', properties: {} }],
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
      mcpCatalog: McpCatalog.loadShipped(),
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
  return { llm: llmFactory, drainInput, usageStore, sessionStore };
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

  async function modelServer(usage: { prompt_tokens: number; completion_tokens: number } | undefined) {
    const started = await startModelEndpointStub(usage === undefined ? {} : { usage });
    servers.push(started.server);
    return started.baseUrl;
  }

  async function useUpToday(usageStore: SqliteTokenFactoryUsageStore, tokens: number) {
    await usageStore.addUsage({
      usage_date: NOW.toISOString().slice(0, 10),
      model_id: 'nvidia/nemotron-3-super-120b-a12b',
      input_tokens: tokens,
      output_tokens: 0,
    });
  }

  async function usedToday(usageStore: SqliteTokenFactoryUsageStore) {
    return (await usageStore.getUsage({ usage_date: NOW.toISOString().slice(0, 10) }))?.used_tokens;
  }

  it('admits a Token Factory turn under the cap and counts the usage each model call reports', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 300, completion_tokens: 50 });
    const { llm, usageStore } = await startTurn({ cap: CAP, tokenFactoryUrl });

    const { modelClient, modelId } = await llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat');
    expect(modelId).toBe('nvidia/nemotron-3-super-120b-a12b');
    await modelClient.createNonStream(ask);
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(700);
  });

  it('refuses a new Token Factory turn with the typed error once the cap is reached', async () => {
    const { llm, usageStore } = await startTurn({ cap: CAP });
    await useUpToday(usageStore, CAP);

    await expect(llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat')).rejects.toBeInstanceOf(
      TokenFactoryDailyCapError,
    );
  });

  it('stops a running turn before its next model call when the cap is reached mid-turn', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 900, completion_tokens: 200 });
    const { llm, usageStore } = await startTurn({ cap: CAP, tokenFactoryUrl });
    const { modelClient } = await llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat');

    await modelClient.createNonStream(ask);
    expect(await usedToday(usageStore)).toBe(1100);

    await expect(modelClient.createNonStream(ask)).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
    expect(await usedToday(usageStore)).toBe(1100);
  });

  it('never refuses and never counts a turn on another provider', async () => {
    const localUrl = await modelServer({ prompt_tokens: 300, completion_tokens: 50 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl });
    await useUpToday(usageStore, CAP);

    const { modelClient, modelId } = await llm('local-vllm/local-model', 'chat');
    expect(modelId).toBe('local-model');
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(CAP);
  });

  it('applies the cap to a local turn that TOKEN_FACTORY_MODE=force routes to Token Factory', async () => {
    configuration.TOKEN_FACTORY_MODE = 'force';
    const { llm, usageStore } = await startTurn({ cap: CAP });
    await useUpToday(usageStore, CAP);

    await expect(llm('local-vllm/local-model', 'chat')).rejects.toBeInstanceOf(TokenFactoryDailyCapError);
  });

  it('counts Token Factory traffic that TOKEN_FACTORY_MODE=fallback sends after the local model failed', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl: DEAD_URL });
    const { modelClient } = await llm('local-vllm/local-model', 'chat');

    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(150);
  });

  it('does not count a fallback-mode call the local model answered itself', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const localUrl = await modelServer({ prompt_tokens: 7, completion_tokens: 3 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl });
    const { modelClient } = await llm('local-vllm/local-model', 'chat');

    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBeUndefined();
  });

  it('stops using the Token Factory fallback once the cap is reached', async () => {
    configuration.TOKEN_FACTORY_MODE = 'fallback';
    configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
    const { llm, usageStore } = await startTurn({ cap: CAP, localUrl: DEAD_URL });
    const { modelClient } = await llm('local-vllm/local-model', 'chat');
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

  it('has no cap when the variable is unset, yet still counts the usage', async () => {
    const tokenFactoryUrl = await modelServer({ prompt_tokens: 9_000_000, completion_tokens: 1 });
    const { llm, usageStore } = await startTurn({ cap: undefined, tokenFactoryUrl });

    const { modelClient } = await llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat');
    await modelClient.createNonStream(ask);

    expect(await usedToday(usageStore)).toBe(9_000_001);
  });

  describe('model usage recorded for the turn', () => {
    async function* turnDone(): AsyncGenerator<TurnStreamingEvent> {
      yield {
        type: SessionEventType.TURN_DONE,
        id: 'evt_done',
        created_at: NOW.toISOString(),
        state: {
          status: 'done',
          output: {
            type: 'model.message',
            id: 'evt_msg',
            thread_id: 'main',
            created_at: NOW.toISOString(),
            content: 'ok',
          },
          required_actions: [],
          completed_at: NOW.toISOString(),
        },
        thread_id: null,
      };
    }

    async function persistedUsageEvents(setup: Awaited<ReturnType<typeof startTurn>>) {
      const append = jest.spyOn(setup.sessionStore, 'appendEventsToDoneTurn').mockResolvedValue(undefined);
      await drainTurnEvents({ ...setup.drainInput, trackedStream: turnDone() });
      return append.mock.calls
        .flatMap(([input]) => input.events)
        .filter((event): event is ModelUsagePersistedEvent => event.type === 'aman.model.usage');
    }

    it('attributes each role to the model that answered, with the provider-reported tokens and the table price', async () => {
      const tokenFactoryUrl = await modelServer({ prompt_tokens: 300, completion_tokens: 50 });
      const localUrl = await modelServer({ prompt_tokens: 7, completion_tokens: 3 });
      const setup = await startTurn({ cap: undefined, tokenFactoryUrl, localUrl });
      const chat = await setup.llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat');
      const compaction = await setup.llm('local-vllm/local-model', 'compaction');

      await chat.modelClient.createNonStream(ask);
      await chat.modelClient.createNonStream(ask);
      await compaction.modelClient.createNonStream(ask);
      const events = await persistedUsageEvents(setup);

      expect(events).toEqual([
        expect.objectContaining({
          type: 'aman.model.usage',
          role: 'chat',
          model_name: 'tokenfactory/nemotron-3-super-120b-a12b',
          model_id: 'nvidia/nemotron-3-super-120b-a12b',
          display_name: 'Nemotron 3 Super',
          provider: 'tokenfactory',
          calls: 2,
          reported_calls: 2,
          input_tokens: 600,
          output_tokens: 100,
        }),
        expect.objectContaining({
          role: 'compaction',
          model_name: 'local-vllm/local-model',
          display_name: 'local-model',
          provider: 'custom',
          calls: 1,
          input_tokens: 7,
          output_tokens: 3,
          cost_usd: null,
        }),
      ]);
      expect(events[0]).toHaveProperty('cost_usd', expect.closeTo((600 * 0.3 + 100 * 0.9) / 1_000_000, 12));
    });

    it('reports usage as not reported, never a guess, when the provider sends none', async () => {
      const tokenFactoryUrl = await modelServer(undefined);
      const setup = await startTurn({ cap: CAP, tokenFactoryUrl });
      const { modelClient } = await setup.llm('tokenfactory/nemotron-3-super-120b-a12b', 'chat');

      await modelClient.createNonStream(ask);
      const events = await persistedUsageEvents(setup);

      expect(events).toEqual([
        expect.objectContaining({
          role: 'chat',
          calls: 1,
          reported_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
        }),
      ]);
      expect(await usedToday(setup.usageStore)).toBeUndefined();
    });

    it('keeps sub-agent calls apart from the answer and records the model a fallback call went to', async () => {
      configuration.TOKEN_FACTORY_MODE = 'fallback';
      configuration.TOKEN_FACTORY_BASE_URL = await modelServer({ prompt_tokens: 120, completion_tokens: 30 });
      const setup = await startTurn({ cap: CAP, localUrl: DEAD_URL });
      const chat = await setup.llm('local-vllm/local-model', 'chat');
      const delegation = await setup.llm('local-vllm/local-model', 'delegation');

      await chat.modelClient.createNonStream(ask);
      await delegation.modelClient.createNonStream(ask);
      const events = await persistedUsageEvents(setup);

      expect(events.map(event => [event.role, event.provider, event.model_id, event.input_tokens])).toEqual([
        ['chat', 'tokenfactory', 'nvidia/nemotron-3-super-120b-a12b', 120],
        ['delegation', 'tokenfactory', 'nvidia/nemotron-3-super-120b-a12b', 120],
      ]);
    });

    it('records nothing for a turn that made no model call', async () => {
      const setup = await startTurn({ cap: CAP });

      expect(await persistedUsageEvents(setup)).toEqual([]);
    });
  });
});
