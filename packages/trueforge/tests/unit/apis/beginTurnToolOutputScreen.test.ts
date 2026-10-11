import {
  AgentSpecSchema,
  SessionHandle,
  TurnHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';

import { TENANT_ID } from '../../../src/apis/sessions';
import { beginTurnExecution } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
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
import { MEMORY_SCREEN_ENABLED_SETTING_KEY } from '../../../src/runtime/memoryScreenSettings';
import { MEMORY_SUMMARIZE_SETTING_KEY } from '../../../src/runtime/memorySummarizeSettings';
import { toolOutputScreenCapability, type ToolOutputScreenConfig } from '../../../src/runtime/toolOutputScreen';
import { TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY } from '../../../src/runtime/toolOutputScreenSettings';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';

/**
 * `SpaceTurnResourceResolver` constructor args per `beginTurnExecution` call. The
 * resolver itself is replaced: the test only needs the config it was built with.
 */
const mockResolverCtorArgs: unknown[][] = [];

jest.mock('../../../src/runtime/spaceCapability', () => {
  const actual = jest.requireActual('../../../src/runtime/spaceCapability');
  return {
    ...actual,
    SpaceTurnResourceResolver: jest.fn((...args: unknown[]) => {
      mockResolverCtorArgs.push(args);
      return { __mockToolOutputScreenResolver: true };
    }),
  };
});

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

/** The tool-output screen config is the constructor arg carrying the screening tuning. */
function toolOutputScreenConfig(args: unknown[]): ToolOutputScreenConfig {
  const found = args.find(
    (arg): arg is ToolOutputScreenConfig =>
      typeof arg === 'object' &&
      arg !== null &&
      typeof (arg as { enabled: unknown }).enabled === 'boolean' &&
      typeof (arg as { timeoutMs: unknown }).timeoutMs === 'number',
  );
  if (found === undefined) {
    throw new Error('tool-output screen config not found in resolver constructor args');
  }
  return found;
}

describe('beginTurnExecution tool-output screen wiring', () => {
  const originalEnabled = configuration.TOOL_OUTPUT_SCREEN_ENABLED;
  const originalScreenUrl = configuration.MEMORY_SCREEN_URL;

  beforeEach(() => {
    mockResolverCtorArgs.length = 0;
    configuration.TOOL_OUTPUT_SCREEN_ENABLED = true;
    configuration.MEMORY_SCREEN_URL = 'https://screen.internal.example.com';
  });

  afterEach(() => {
    configuration.TOOL_OUTPUT_SCREEN_ENABLED = originalEnabled;
    configuration.MEMORY_SCREEN_URL = originalScreenUrl;
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
    let capturedResolver: unknown;
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const turn = TurnHandle.fromRecord<TurnCustom>({
      store: sessionStore,
      turn: {
        turn_id: 'turn-screen-wiring',
        session_id: 's1',
        first_turn_id: 'turn-screen-wiring',
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
    jest.spyOn(handle, 'createTurn').mockImplementation(input => {
      capturedResolver = input.resolver;
      return Promise.resolve(turn);
    });

    const { drainInput } = await beginTurnExecution({
      session: handle,
      input: [],
      previous_turn_id: undefined,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      deps: {
        globalSettingsStore: store,
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
        logger,
      },
    });
    try {
      return { capturedResolver, ctorArgs: mockResolverCtorArgs.at(-1) ?? [] };
    } finally {
      drainInput.executionDeadline.dispose();
    }
  }

  it('reads the setting once per turn and hands the persisted override to the resolver', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new CountingGlobalSettingsStore(new SqliteGlobalSettingsStore(db));
    await store.setSetting({ key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, value: 'false' });

    const { capturedResolver, ctorArgs } = await beginTurnWithStore(store);

    // One settings read per turn per domain: tool-output screen, turn summarization and
    // the recall screen.
    expect(store.getSettingCalls).toEqual([
      { key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY },
      { key: MEMORY_SUMMARIZE_SETTING_KEY },
      { key: MEMORY_SCREEN_ENABLED_SETTING_KEY },
    ]);
    expect(capturedResolver).toEqual({ __mockToolOutputScreenResolver: true });
    expect(toolOutputScreenConfig(ctorArgs).enabled).toBe(false);
  });

  it('falls back to the env default when no override is stored', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new CountingGlobalSettingsStore(new SqliteGlobalSettingsStore(db));

    const { ctorArgs } = await beginTurnWithStore(store);

    expect(store.getSettingCalls).toEqual([
      { key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY },
      { key: MEMORY_SUMMARIZE_SETTING_KEY },
      { key: MEMORY_SCREEN_ENABLED_SETTING_KEY },
    ]);
    expect(toolOutputScreenConfig(ctorArgs).enabled).toBe(true);
  });

  it('resolves the screen off when a stored ON override meets an unconfigured service', async () => {
    // The exact failing sequence: a stale ON override (e.g. left behind when the
    // screening sidecar is removed) with MEMORY_SCREEN_URL unset. The withholder must
    // NOT be attached — an empty classifier URL fails every classification closed,
    // so attaching it would silently blind the agent to every open-world tool result.
    configuration.MEMORY_SCREEN_URL = '';
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new CountingGlobalSettingsStore(new SqliteGlobalSettingsStore(db));
    await store.setSetting({ key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY, value: 'true' });

    const { ctorArgs } = await beginTurnWithStore(store);

    const config = toolOutputScreenConfig(ctorArgs);
    expect(config.enabled).toBe(false);
    expect(toolOutputScreenCapability({ config })).toBeUndefined();
  });
});
