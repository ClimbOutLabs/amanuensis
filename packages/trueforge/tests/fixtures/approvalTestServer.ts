/**
 * Boots the real server app (`createServerApp`) over a temp-file SQLite database, an
 * inert MCP connector and a scripted OpenAI-compatible endpoint, so approval tests
 * drive `/api/v1/...` rather than harness internals.
 *
 * The database lives in a temp directory rather than `:memory:` so `restart()` can
 * drop every in-process registry and reopen the same durable state.
 *
 * The `inert` connector is stored directly, like one a user added by URL. The first-party origin
 * list starts empty, so nothing is first-party until a test sets up an Email or Calendar address.
 */
import { Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import type { SandboxProvider } from '@truefoundry/trueforge-core/core';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import { TENANT_ID } from '../../src/apis/sessions';
import { createServerApp } from '../../src/app';
import type { Authenticator } from '../../src/auth/authenticator';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import { createAuthenticator } from '../../src/auth/createAuthenticator';
import { McpCatalog } from '../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../src/catalog/SkillCatalog';
import configuration, { TrueForgeAuthMode } from '../../src/config';
import { BriefItemCompletionStore } from '../../src/db/briefItemCompletionStore';
import type { IMcpServerStore } from '../../src/db/mcpServerStore';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteApprovalTokenStore } from '../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { SqliteChatDeletionStore } from '../../src/db/sqlite/chat-deletion-store/SqliteChatDeletionStore';
import { SqliteChatImageStore } from '../../src/db/sqlite/chat-image-store/SqliteChatImageStore';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteGoogleConnectionStore } from '../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { SqliteLocalUserStore } from '../../src/db/sqlite/local-user-store/SqliteLocalUserStore';
import { SqliteMcpServerStore } from '../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteMcpToolGrantStore } from '../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteModelProviderStore } from '../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteRepositoryStore } from '../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionMetricsStore } from '../../src/db/sqlite/session-metrics/SqliteSessionMetricsStore';
import { SqliteSessionStore } from '../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { evalSources, type EvalSources } from '../../src/eval/fixtures';
import { closePersonaKnowledgeIndexers } from '../../src/personaKnowledge/knowledgeIndexer';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { createChatImageService } from '../../src/runtime/chatImages/chatImageService';
import { createImageReencoder } from '../../src/runtime/chatImages/reencodeInSandbox';
import { ChatSearchIndexer } from '../../src/runtime/chatSearchIndexing';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { createOutboundSecretSource } from '../../src/runtime/outboundSecrets';
import { createSentinelServices } from '../../src/runtime/sentinelServices';
import { TurnDrainRegistry } from '../../src/runtime/turnDrains';
import { deliveryDeps } from './deliveryDeps';
import { INERT_SERVER_NAME, startInertMcpServer, type InertMcpServer } from './inertMcpServer';
import { startScriptedModelServer, type ScriptedModelServer } from './scriptedModelServer';
import { uncappedTokenFactoryBudget } from './uncappedTokenFactoryBudget';

export const MODEL_PROVIDER_NAME = 'scripted';
export const MODEL_FQN = `${MODEL_PROVIDER_NAME}/scripted-model`;
/** A second configured model, so a test can prove which one a turn actually used. */
export const ALT_MODEL_FQN = `${MODEL_PROVIDER_NAME}/scripted-alt-model`;

type SqliteDb = ReturnType<typeof createSqliteDb>;

export interface ApprovalTestServer {
  /** Sends one request through the mounted app; `path` is a full API path. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Drops every in-process registry and remounts the app over the same database. */
  restart: () => Promise<void>;
  mcp: InertMcpServer;
  model: ScriptedModelServer;
  /** A store bound to the current database — call fresh after `restart()`, never cache. */
  mcpServerStore: () => IMcpServerStore;
  /** Same contract as `mcpServerStore`: reads private turn metadata the HTTP surface does not expose. */
  sessionStore: () => SqliteSessionStore;
  /** The database itself, so a test can construct any other store over the same data. */
  db: () => SqliteDb;
  /** Replaces the first-party origin list, as booting with other Email and Calendar addresses would. */
  setFirstPartyOrigins: (origins: string[]) => void;
  /**
   * Turns eval mode on or off, as booting with another `AMAN_EVAL_MODE` would. While on, Gmail and Google Calendar
   * are the invented inbox and calendar, and only their cards can be allowed.
   */
  setEvalMode: (on: boolean) => void;
  /** The invented inbox and calendar eval mode reads and writes, so a test can see what a turn saved. */
  evalSources: () => EvalSources;
  close: () => Promise<void>;
}

function buildApp(input: {
  db: SqliteDb;
  sandboxProvider: SandboxProvider | undefined;
  authenticator: Authenticator;
  /** Signs the one owner in with an email and password, as `TRUEFORGE_AUTH_MODE=local` does. */
  localSignIn: boolean;
  turnDrains: TurnDrainRegistry;
}): ReturnType<typeof createServerApp> {
  const { db, sandboxProvider, turnDrains } = input;
  const sessionStore = new SqliteSessionStore(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const mcpServerStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore,
    clientName: 'approval-test-fixture',
  });
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const skillStore = new SqliteSkillStore(db);
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const sentinelAuditStore = new SentinelAuditStore(db);
  const sentinelSettingsStore = new SqliteSentinelSettingsStore(db);
  const mcpToolGrantStore = new SqliteMcpToolGrantStore(db);
  const googleConnectionStore = new SqliteGoogleConnectionStore(db);
  // Same composition as main.ts, so approval tokens are durable and shared across turns.
  const outboundSecrets = createOutboundSecretSource({
    configured: () => [],
    modelProviders: modelProviderStore,
    sandboxProviders: sandboxProviderStore,
    mcpServers: mcpServerStore,
    tokens: tokenStore,
    googleConnections: googleConnectionStore,
  });
  const sentinelServices = createSentinelServices({
    demoMode: false,
    demoSendAllowlist: [],
    mailPolicyPath: undefined,
    mailPolicyStatusPath: undefined,
    audit: sentinelAuditStore,
    settings: sentinelSettingsStore,
    approvalTokens: new SqliteApprovalTokenStore(db),
    toolGrants: mcpToolGrantStore,
    outboundSecrets,
  });
  const personaStore = new SqlitePersonaStore(db);
  const localUserStore = input.localSignIn ? new SqliteLocalUserStore(db) : undefined;
  const authenticator =
    localUserStore === undefined
      ? input.authenticator
      : createAuthenticator({ mode: TrueForgeAuthMode.Local, localUserStore, globalSettingsStore });
  return createServerApp({
    chatDeletionStore: new SqliteChatDeletionStore({ db, turnArtifactStore: new SqliteTurnArtifactStore(db) }),
    chatSearchIndexer: new ChatSearchIndexer({
      sessionStore,
      globalSettingsStore,
      sentinelSettingsStore,
      personaStore,
      logger: createLogger({ silent: true }),
    }),
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.loadShipped(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    withTransaction: callback => db.transaction().execute(callback),
    tokenStore,
    mcpToolGrantStore,
    googleConnectionStore,
    skillStore,
    sandboxProviderStore,
    sandboxProviderResolver: sandboxProvider === undefined ? undefined : () => Promise.resolve(sandboxProvider),
    agentStore,
    personalizationStore: new SqlitePersonalizationStore(db),
    personaStore,
    modelProviderStore,
    spaceStore: new SqliteSpaceStore(db),
    repositoryStore: new SqliteRepositoryStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    chatImages: createChatImageService({
      store: new SqliteChatImageStore(db),
      sessionStore,
      turnArtifactStore: new SqliteTurnArtifactStore(db),
      reencode: createImageReencoder({ resolveSandbox: () => null }),
      sentinel: sentinelServices,
      fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
    }),
    globalSettingsStore,
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    tidyMemoryNow: () => Promise.resolve({ status: 'busy' }),
    sessionStore,
    sentinelAuditStore,
    sentinelSettingsStore,
    briefItemStore: new BriefItemCompletionStore(db),
    ...deliveryDeps(db),
    sessions: new Sessions({ sessionStore, sentinelServices }),
    activeTurns: new ActiveTurnRegistry(),
    turnDrains,
    requestReplyRouter: new RequestReplyRouter(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger: createLogger({ silent: true }),
    oidcDiscovery: undefined,
    localUserStore,
    authenticator,
    authorizer: new TrueForgeAuthorizer(),
    outboundSecrets,
    schedulerStatus: () => 'elsewhere',
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
  });
}

/** The memory folder the test run was configured with, read before any test changes it. */
const CONFIGURED_MEMORY_DIR = configuration.MEMORY_MARKDOWN_DIR;

export async function startApprovalTestServer(options?: {
  sandboxProvider?: SandboxProvider | undefined;
  /** Replaces the standalone authenticator, for tests that need distinct or unauthenticated callers. */
  authenticator?: Authenticator | undefined;
  /** Adds the inert connector's opt-in `web_search` tool. */
  inertWebSearch?: boolean | undefined;
  /** Adds the inert connector's opt-in read of one page by its id. */
  inertPageById?: boolean | undefined;
  /** Adds the inert connector's opt-in `search_messages` lookup. */
  inertMessageSearch?: boolean | undefined;
  /** Runs local sign-in instead of the standalone user: the first request must create the owner's sign-in. */
  localSignIn?: boolean | undefined;
}): Promise<ApprovalTestServer> {
  const localSignIn = options?.localSignIn === true;
  const authenticator = options?.authenticator ?? createAuthenticator({ mode: TrueForgeAuthMode.Standalone });
  const mcp = await startInertMcpServer({
    webSearch: options?.inertWebSearch === true,
    pageById: options?.inertPageById === true,
    messageSearch: options?.inertMessageSearch === true,
  });
  const model = await startScriptedModelServer();
  const directory = await mkdtemp(join(tmpdir(), 'tfy-approval-'));
  const databaseFile = join(directory, 'approvals.sqlite');

  let db = createSqliteDb(databaseFile);
  await migrateSqliteToLatest(db);

  if (options?.sandboxProvider !== undefined) {
    await new SqliteSandboxProviderStore(db).upsertSandboxProvider({
      tenant_id: TENANT_ID,
      manifest: {
        type: 'daytona',
        api_url: 'https://sandbox.test.example.com/api',
        auth: { api_key: 'fixture-key' },
        exec_timeout_ms: 60_000,
        auto_stop_interval_in_minutes: 0,
        auto_archive_interval_in_minutes: 0,
        auto_delete_interval_in_minutes: 0,
      },
      status: 'ready',
      status_reason: null,
      build_metadata: null,
    });
  }

  await new SqliteModelProviderStore(db).upsertProvider({
    tenant_id: TENANT_ID,
    name: MODEL_PROVIDER_NAME,
    manifest: {
      type: 'custom',
      name: MODEL_PROVIDER_NAME,
      base_url: model.baseUrl,
      auth: { api_key: 'scripted-key' },
      models: [
        {
          model_id: 'scripted-model',
          name: 'scripted-model',
          // A custom model takes one request at a time by default; a test that holds two chats' turns open needs two.
          properties: {
            context_length: 128000,
            max_output_tokens: 4096,
            reasoning_efforts: ['none'],
            max_concurrent_requests: 2,
          },
        },
        {
          model_id: 'scripted-alt-model',
          name: 'scripted-alt-model',
          properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['none'] },
        },
      ],
    },
  });

  await new SqliteMcpServerStore(db).upsertServer({
    tenant_id: TENANT_ID,
    name: INERT_SERVER_NAME,
    manifest: {
      type: 'remote',
      name: INERT_SERVER_NAME,
      url: mcp.url,
      description: 'Inert connector used by approval-flow tests.',
    },
    first_party: false,
  });

  const originalFirstPartyOrigins = configuration.FIRST_PARTY_MCP_ORIGINS;
  const originalEvalMode = configuration.AMAN_EVAL_MODE;
  // Each server keeps its own memory, so one test's chats are never recalled into another's. A test that chose a
  // memory folder itself keeps it.
  const originalMemoryDir = configuration.MEMORY_MARKDOWN_DIR;
  if (originalMemoryDir === CONFIGURED_MEMORY_DIR) {
    configuration.MEMORY_MARKDOWN_DIR = join(directory, 'memory');
  }
  const originalAuthMode = configuration.TRUEFORGE_AUTH_MODE;
  if (localSignIn) {
    configuration.TRUEFORGE_AUTH_MODE = 'local';
  }
  configuration.FIRST_PARTY_MCP_ORIGINS = [];

  // One registry for the server's life, so close() can wait for turn drains the way main.ts does.
  const turnDrains = new TurnDrainRegistry();
  let app = buildApp({ db, sandboxProvider: options?.sandboxProvider, authenticator, localSignIn, turnDrains });

  return {
    // Hono's request() is sync-or-async depending on the route; the fixture
    // contract is uniformly async, so normalise here rather than at every call.
    request: async (path, init) => await app.request(path, init),
    restart: async () => {
      await app.guidesSettled();
      // A restart stands in for the process going away, so running replies are cut off, not drained.
      await db.destroy();
      db = createSqliteDb(databaseFile);
      app = buildApp({ db, sandboxProvider: options?.sandboxProvider, authenticator, localSignIn, turnDrains });
    },
    mcp,
    model,
    mcpServerStore: () => new SqliteMcpServerStore(db),
    sessionStore: () => new SqliteSessionStore(db),
    db: () => db,
    setFirstPartyOrigins: origins => {
      configuration.FIRST_PARTY_MCP_ORIGINS = origins;
    },
    setEvalMode: on => {
      configuration.AMAN_EVAL_MODE = on;
    },
    evalSources,
    close: async () => {
      configuration.FIRST_PARTY_MCP_ORIGINS = originalFirstPartyOrigins;
      configuration.AMAN_EVAL_MODE = originalEvalMode;
      configuration.MEMORY_MARKDOWN_DIR = originalMemoryDir;
      configuration.TRUEFORGE_AUTH_MODE = originalAuthMode;
      // The guide installs, and the indexing they queue, write into directories removed below, so they finish first.
      await app.guidesSettled();
      await closePersonaKnowledgeIndexers();
      // Like main.ts shutdown: a finished turn's drain still writes events and memory (a scheduled
      // run saves to the vault), so it settles before the database and the caller's directories go.
      await turnDrains.shutdownAndWait({ timeoutMs: configuration.TURN_DRAIN_SHUTDOWN_TIMEOUT_MS });
      await db.destroy();
      await model.close();
      await mcp.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
