import {
  AgentSpecSchema,
  SessionHandle,
  TurnHandle,
  type SessionTitleSeed,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';

import { beginTurnExecution } from '../../../src/apis/turns';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
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
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TENANT_ID } from '../../../src/tenancy';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';
import { InMemorySentinelSettingsStore } from '../../fixtures/InMemorySentinelSettingsStore';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const SESSION_ID = 's-auto-title';
const FIRST_MESSAGE = 'Give me my morning brief';

interface ChatSetup {
  source?: { type: 'schedule'; id: string; run_id: string } | undefined;
  lastTurnId?: string | undefined;
  offline?: boolean | undefined;
}

/** Begins one turn on a chat in the given state and returns what the turn wired up. */
async function beginTurn({
  input,
  chat,
  unattended,
  titleSeed,
}: {
  input: Parameters<typeof beginTurnExecution>[0]['input'];
  chat: ChatSetup;
  unattended?: boolean | undefined;
  titleSeed?: SessionTitleSeed | undefined;
}) {
  const logger = createLogger({ silent: true });
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const sentinelSettingsStore = new InMemorySentinelSettingsStore();
  if (chat.offline === true) {
    await sentinelSettingsStore.patch({
      tenant_id: TENANT_ID,
      created_by: STANDALONE_REQUEST_CONTEXT.subject.id,
      offline_mode: true,
      tier2_auto_allow: undefined,
      search_without_asking: undefined,
      maps_without_asking: undefined,
      sandbox_without_asking: undefined,
    });
  }
  await sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: SESSION_ID,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    agent: { type: 'inline', spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }) },
    custom: null,
    metadata: {},
    external_id: null,
    source: chat.source ?? null,
  });
  const record = await sessionStore.getSession({ tenant_id: TENANT_ID, session_id: SESSION_ID });
  if (record === undefined) {
    throw new Error('test session was never created');
  }
  const handle = new SessionHandle<SessionCustom, TurnCustom>({
    store: sessionStore,
    session: { ...record, last_turn_id: chat.lastTurnId ?? null },
  });
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const turn = TurnHandle.fromRecord<TurnCustom>({
    store: sessionStore,
    turn: {
      turn_id: 'turn-auto-title',
      session_id: SESSION_ID,
      first_turn_id: 'turn-auto-title',
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
  const createTurn = jest.spyOn(handle, 'createTurn').mockImplementation(() => Promise.resolve(turn));

  try {
    const { drainInput } = await beginTurnExecution({
      session: handle,
      input,
      previous_turn_id: undefined,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      unattended,
      title_seed: titleSeed,
      deps: {
        sentinelSettingsStore,
        mcpCatalog: McpCatalog.loadShipped(),
        globalSettingsStore: new SqliteGlobalSettingsStore(db),
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
        logger,
      },
    });
    try {
      return {
        seed: createTurn.mock.calls[0]?.[0].update_session_title_if_not_exist,
        autoTitle: drainInput.auto_title,
      };
    } finally {
      drainInput.executionDeadline.dispose();
    }
  } finally {
    await db.destroy();
  }
}

const userMessage = [{ type: 'user.message' as const, content: FIRST_MESSAGE }];

describe('beginTurnExecution chat titles', () => {
  it('seeds the first message as the title and arms the title call on a first interactive turn', async () => {
    const { seed, autoTitle } = await beginTurn({ input: userMessage, chat: {} });

    expect(seed).toEqual({ title: FIRST_MESSAGE, source: 'first_message' });
    expect(autoTitle?.modelFqn).toBe('test-provider/test-model');
    expect(autoTitle?.userText).toBe(FIRST_MESSAGE);
  });

  it('makes no title call while offline, and still keeps the first message as the title', async () => {
    const { seed, autoTitle } = await beginTurn({ input: userMessage, chat: { offline: true } });

    expect(seed).toEqual({ title: FIRST_MESSAGE, source: 'first_message' });
    expect(autoTitle).toBeUndefined();
  });

  it('does not arm the title call on a later turn', async () => {
    const { seed, autoTitle } = await beginTurn({ input: userMessage, chat: { lastTurnId: 'turn-earlier' } });

    expect(seed).toBeNull();
    expect(autoTitle).toBeUndefined();
  });

  it('seeds a scheduled chat with its fixed title and never arms the title call', async () => {
    const fixed = { title: 'Morning brief · Thu 22 Oct', source: 'auto' as const };
    const { seed, autoTitle } = await beginTurn({
      input: userMessage,
      chat: { source: { type: 'schedule', id: 'sch-1', run_id: 'run-1' } },
      unattended: true,
      titleSeed: fixed,
    });

    expect(seed).toEqual(fixed);
    expect(autoTitle).toBeUndefined();
  });

  it('seeds no title and arms no title call for a turn with no text', async () => {
    const { seed, autoTitle } = await beginTurn({ input: [], chat: {} });

    expect(seed).toBeNull();
    expect(autoTitle).toBeUndefined();
  });
});
