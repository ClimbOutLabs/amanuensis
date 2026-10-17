import {
  AgentSpecSchema,
  SessionHandle,
  TurnHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';

import { TENANT_ID } from '../../../src/apis/sessions';
import { beginTurnExecution } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import configuration from '../../../src/config';
import type {
  GetGlobalSettingInput,
  GlobalSettingRecord,
  IGlobalSettingsStore,
  SetGlobalSettingInput,
} from '../../../src/db/globalSettingsStore';
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
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import { MEMORY_SUMMARIZE_SETTING_KEY } from '../../../src/runtime/memorySummarizeSettings';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

/** Delegates to a real store while recording every `getSetting` call. */
class CountingGlobalSettingsStore implements IGlobalSettingsStore {
  readonly getSettingCalls: GetGlobalSettingInput[] = [];

  constructor(private readonly inner: IGlobalSettingsStore) {}

  async getSetting(input: GetGlobalSettingInput): Promise<GlobalSettingRecord | undefined> {
    this.getSettingCalls.push(input);
    return this.inner.getSetting(input);
  }

  async setSetting(input: SetGlobalSettingInput): Promise<GlobalSettingRecord> {
    return this.inner.setSetting(input);
  }

  async deleteSetting(input: GetGlobalSettingInput): Promise<void> {
    return this.inner.deleteSetting(input);
  }
}

describe('beginTurnExecution turn-summarization wiring', () => {
  const originalSummarize = configuration.MEMORY_SUMMARIZE;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_SUMMARIZE = false;
    configuration.MEMORY_BACKEND = 'markdown';
  });

  afterEach(() => {
    configuration.MEMORY_SUMMARIZE = originalSummarize;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  async function beginTurnWithStore(store: CountingGlobalSettingsStore) {
    const logger = createLogger({ silent: true });
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const tokenStore = new SqliteOAuthTokenStore(db);
    const sessionStore = new SqliteSessionStore(db);
    const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
    await sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: 's1',
      created_by_subject: {
        subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
        subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
        subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
      },
      agent: { type: 'inline', spec: agentSpec },
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
        turn_id: 'turn-summarize-wiring',
        session_id: 's1',
        first_turn_id: 'turn-summarize-wiring',
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
    jest.spyOn(handle, 'createTurn').mockImplementation(() => Promise.resolve(turn));

    // A real markdown client against a temp dir: beginTurnExecution only checks that a
    // client resolved, and this keeps the test free of type-assertion escapes.
    const memoryDir = await mkdtemp(join(tmpdir(), 'summarize-wiring-'));
    const memoryClient = new MarkdownMemoryClient({ baseDir: memoryDir, namespace: 'test' });
    try {
      const { drainInput } = await beginTurnExecution({
        session: handle,
        input: [],
        previous_turn_id: undefined,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
        deps: {
          mcpCatalog: McpCatalog.load(),
          globalSettingsStore: store,
          tokenFactoryBudget: uncappedTokenFactoryBudget,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          turnDrains: new TurnDrainRegistry(),
          tokenStore,
          agentStore: new SqliteAgentStore(db),
          modelProviderStore: new SqliteModelProviderStore(db),
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
          memoryClient,
          logger,
        },
      });
      try {
        return { summarize: drainInput.memory?.summarize };
      } finally {
        drainInput.executionDeadline.dispose();
      }
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  }

  async function storeWithOverride(value: string): Promise<CountingGlobalSettingsStore> {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new CountingGlobalSettingsStore(new SqliteGlobalSettingsStore(db));
    await store.setSetting({ key: MEMORY_SUMMARIZE_SETTING_KEY, value });
    return store;
  }

  it('builds the summarize context when a stored true override beats an env default of false', async () => {
    const store = await storeWithOverride('true');

    const { summarize } = await beginTurnWithStore(store);

    // The summarization setting is read once per turn (the store also serves the
    // unrelated tool-output-screening read on the same path).
    expect(store.getSettingCalls.filter(call => call.key === MEMORY_SUMMARIZE_SETTING_KEY)).toEqual([
      { key: MEMORY_SUMMARIZE_SETTING_KEY },
    ]);
    expect(summarize).toBeDefined();
  });

  it('leaves the summarize context absent with no override and an env default of false', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new CountingGlobalSettingsStore(new SqliteGlobalSettingsStore(db));

    const { summarize } = await beginTurnWithStore(store);

    // The summarization setting is read once per turn (the store also serves the
    // unrelated tool-output-screening read on the same path).
    expect(store.getSettingCalls.filter(call => call.key === MEMORY_SUMMARIZE_SETTING_KEY)).toEqual([
      { key: MEMORY_SUMMARIZE_SETTING_KEY },
    ]);
    expect(summarize).toBeUndefined();
  });

  it('a stored false override wins over an env default of true', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const store = await storeWithOverride('false');

    const { summarize } = await beginTurnWithStore(store);

    expect(summarize).toBeUndefined();
  });

  it('summarization stays off on a non-markdown backend even when enabled', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    const store = await storeWithOverride('true');

    const { summarize } = await beginTurnWithStore(store);

    // The markdown-only gate is preserved: the experimental backend retains verbatim.
    expect(summarize).toBeUndefined();
  });
});
