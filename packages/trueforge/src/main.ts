/**
 * Server entry point: validates config, migrates the selected database, wires
 * stores, and starts the HTTP server. Any config, migration, or store error
 * aborts startup.
 *
 * `STANDALONE=true` (default): SQLite, no Redis. `STANDALONE=false`: Postgres + Redis.
 *
 * Config is validated at import time (`./config`). Runtime startup failures
 * (migrate, Redis, listen) are caught below and exit non-zero. SQLite vs
 * Postgres store modules stay dynamic so only the active engine is loaded.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureLocalSandboxRootParent,
  prepareCodeModeSocketParent,
  removeCodeModeSocketParent,
} from './sandbox/localLifecycle';
import { setCachedLocalSandboxSupport } from './sandbox/localRuntime';

let configuration: typeof import('./config').default;
let isOidcConfigured: typeof import('./config').isOidcConfigured;
let isTrueFoundryModeEnabled: typeof import('./config').isTrueFoundryModeEnabled;
let getTrueForgeAuthMode: typeof import('./config').getTrueForgeAuthMode;
let getConfiguredSecretValues: typeof import('./config').getConfiguredSecretValues;
let assertNetworkAuthRequirement: typeof import('./config').assertNetworkAuthRequirement;
let getPublicUiBasePath: typeof import('./config').getPublicUiBasePath;
let TrueForgeAuthMode: typeof import('./config').TrueForgeAuthMode;
let isPlaceholderTrueForgeApiKey: typeof import('./config').isPlaceholderTrueForgeApiKey;

try {
  ({
    default: configuration,
    isOidcConfigured,
    isTrueFoundryModeEnabled,
    getTrueForgeAuthMode,
    getConfiguredSecretValues,
    assertNetworkAuthRequirement,
    getPublicUiBasePath,
    TrueForgeAuthMode,
    isPlaceholderTrueForgeApiKey,
  } = await import('./config'));
} catch (error) {
  console.error(
    'Failed to start server: Failed to load configuration:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

import { serve } from '@hono/node-server';
import {
  CancellationReason,
  Sessions,
  type ISessionStore,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { ApprovalTokenStore } from '@truefoundry/trueforge-core/core';
import { heartbeatKey, RequestReplyExecutor, RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import type { Kysely, Transaction } from 'kysely';
import type { RedisClientType } from 'redis';
import type { Logger } from 'winston';

import { createServerApp } from './app';
import { TrueForgeAuthorizer, type Authorizer } from './auth/authorizer';
import { createAuthenticator } from './auth/createAuthenticator';
import { resolveRequestContext, type RequestContext } from './auth/identity';
import { startOidcDiscovery } from './auth/oidc';
import { McpCatalog } from './catalog/McpCatalog';
import { ModelCatalog } from './catalog/ModelCatalog';
import { SandboxCatalog } from './catalog/SandboxCatalog';
import { SkillCatalog } from './catalog/SkillCatalog';
import { type DistributedServerConfiguration } from './config';
import { createController } from './controller';
import type { AgentRecord, IAgentStore } from './db/agentStore';
import type { IChatImageStore } from './db/chatImageStore';
import type { ICompletedTurnEventStore } from './db/completedTurnEvents';
import type { IGlobalSettingsStore } from './db/globalSettingsStore';
import type { IGoogleConnectionStore } from './db/googleConnectionStore';
import type { IMcpServerStore, IMcpServerWithAuthStore } from './db/mcpServerStore';
import { McpServerWithAuthStore } from './db/McpServerWithAuthStore';
import type { IMcpToolGrantStore } from './db/mcpToolGrantStore';
import type { IModelProviderStore } from './db/modelProviderStore';
import type { IPersonalizationStore } from './db/personalizationStore';
import type { IPersonaStore } from './db/personaStore';
import type { PostgresAgentStore } from './db/postgres/agent-store/PostgresAgentStore';
import type { Database as PostgresDatabase } from './db/postgres/types';
import type { IRepositoryStore } from './db/repositoryStore';
import type { ISandboxProviderStore } from './db/sandboxProviderStore';
import type { IScheduleStore } from './db/scheduleStore';
import { SentinelAuditStore, type ISentinelAuditStore, type SentinelAuditDatabase } from './db/sentinelAuditStore';
import type { ISentinelSettingsStore } from './db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from './db/sessionCustom';
import type { ISessionMetricsStore } from './db/sessionMetricsStore';
import type { ISkillStore } from './db/skillStore';
import type { ISpaceStore } from './db/spaceStore';
import type { Database as SqliteDatabase } from './db/sqlite/types';
import type { ITokenFactoryUsageStore } from './db/tokenFactoryUsageStore';
import type { WithTransaction } from './db/transaction';
import type { ITurnArtifactStore } from './db/turnArtifactStore';
import { mountFrontend } from './frontend';
import { serverTlsServeOptions } from './http/tls';
import { createServerLogger, shouldColorize } from './logger';
import type { IOAuthTokenStore } from './mcp/auth/types';
import { PACKAGE_VERSION } from './packageVersion';
import { ActiveTurnRegistry } from './runtime/activeTurns';
import { createChatImageService } from './runtime/chatImages/chatImageService';
import { CHAT_IMAGE_RETENTION_DAYS } from './runtime/chatImages/limits';
import { createImageReencoder } from './runtime/chatImages/reencodeInSandbox';
import { recoverAbandonedCommandExecutions } from './runtime/commandExecutionRecovery';
import { EventSubscriptionRegistry } from './runtime/event-subscription';
import { warmEmbeddingsAtBoot } from './runtime/memory/embeddingRetrieval';
import { createOutboundSecretSource } from './runtime/outboundSecrets';
import { createSentinelServices } from './runtime/sentinelServices';
import { getSharedRunCodeService } from './runtime/sessionResources';
import { createTokenFactoryBudget } from './runtime/tokenFactoryBudget';
import { ensureEnvManagedTokenFactoryProvider, seedEnvManagedDefaultChatModel } from './runtime/tokenFactoryProvider';
import { TurnDrainRegistry } from './runtime/turnDrains';
import { slotsBackendEnabled } from './sandbox/slotBackend';
import { printStandaloneStartupBanner } from './startupBanner';
import { TENANT_ID } from './tenancy';
import {
  parsePerServerMcpHeaders,
  X_TFG_MCP_HEADERS,
  type PerServerMcpHeaders,
} from './truefoundry/perServerMcpHeaders';
import { TrueFoundryAgentStore } from './truefoundry/TrueFoundryAgentStore';
import { TrueFoundryAuthorizer } from './truefoundry/TrueFoundryAuthorizer';
import { TrueFoundryMcpServerStore } from './truefoundry/TrueFoundryMcpServerStore';
import { TrueFoundryModelProviderStore } from './truefoundry/TrueFoundryModelProviderStore';
import { TrueFoundrySandboxProviderStore } from './truefoundry/TrueFoundrySandboxProviderStore';
import { TrueFoundryServiceFoundryServerClient } from './truefoundry/TrueFoundryServiceFoundryServerClient';
import { TrueFoundrySkillStore } from './truefoundry/TrueFoundrySkillStore';
import { ensureWritableDataDir } from './utils/dataDir';
import { startSttAvailabilityWatcher } from './voice/sttAvailability';

/** Persistence + optional Redis wired for the selected topology. */
interface ServerPersistence<TTransaction> {
  withTransaction: WithTransaction<TTransaction>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  sessionMetricsStore: ISessionMetricsStore;
  tokenStore: IOAuthTokenStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  mcpOAuthStore: IMcpServerWithAuthStore<TTransaction>;
  /** The stored providers themselves, for host checks that need every secret the server holds. */
  modelProviderStore: IModelProviderStore<TTransaction>;
  resolveModelProviderStore: (rc: RequestContext, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (
    rc: RequestContext,
    runAsAgent?: AgentRecord,
    perServerHeaders?: PerServerMcpHeaders,
  ) => IMcpServerWithAuthStore<TTransaction>;
  resolveSandboxProviderStore: (rc: RequestContext) => ISandboxProviderStore<TTransaction>;
  /** Per-request store: DB git skills, or TrueFoundry registry catalog in TrueFoundry mode. */
  resolveSkillStore: (rc: RequestContext) => ISkillStore<TTransaction>;
  resolveAgentStore: (rc: RequestContext) => IAgentStore<TTransaction>;
  /** Import agents: SF assume-user headers on the client; DB store when TrueFoundry mode is off. */
  resolveImportAgentStore: (serviceFoundryServerHeaders: Record<string, string>) => IAgentStore<TTransaction>;
  /** extra pre-resolved stores for scheduled runs */
  agentStore: IAgentStore<TTransaction>;
  /** Persistence instances used directly by fork-only routes not yet migrated to the resolver pattern. */
  skillStore: ISkillStore<TTransaction>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  repositoryStore: IRepositoryStore<TTransaction>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  chatImageStore: IChatImageStore<TTransaction>;
  /** Not tenant-scoped: the persisted live tool-output screen override is global. */
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Not tenant-scoped: one counter row per UTC day for this instance. */
  tokenFactoryUsageStore: ITokenFactoryUsageStore<TTransaction>;
  mcpToolGrantStore: IMcpToolGrantStore<TTransaction>;
  googleConnectionStore: IGoogleConnectionStore;
  sentinelAuditStore: ISentinelAuditStore;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  approvalTokenStore: ApprovalTokenStore;
  destroyDb: () => Promise<void>;
  redis: RedisClientType | undefined;
  /** One shared client for TrueFoundry store resolvers + auth; undefined when TrueFoundry mode is off. */
  serviceFoundryClient: TrueFoundryServiceFoundryServerClient | undefined;
}

/** Shared ServiceFoundry HTTP client when TrueFoundry mode is on; otherwise undefined. */
function createServiceFoundryServerClient(
  logger: Logger,
  headers?: Record<string, string>,
): TrueFoundryServiceFoundryServerClient | undefined {
  if (!isTrueFoundryModeEnabled(configuration)) {
    return undefined;
  }
  const apiKey = configuration.TRUEFOUNDRY_API_KEY;
  if (apiKey === undefined) {
    // this is unreachable because the config validation fails if TRUEFOUNDRY_API_KEY is not set
    // we will refactor config itself later to have a truefoundry section where this will be required
    throw new Error('TRUEFOUNDRY_API_KEY is required when TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL is set.');
  }
  return new TrueFoundryServiceFoundryServerClient({
    serviceFoundryServerUrl: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL,
    logger,
    httpTimeoutMs: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_TIMEOUT_MS,
    httpAgentTimeoutMs: configuration.TRUEFOUNDRY_SERVICEFOUNDRY_HTTP_AGENT_TIMEOUT_MS,
    tls: { enabled: configuration.TRUEFOUNDRY_MTLS_ENABLED, dir: configuration.TRUEFOUNDRY_MTLS_CERTS_DIR },
    apiKey,
    ...(headers !== undefined ? { headers } : {}),
  });
}

/** Per-request SFY skill catalog; otherwise {@link persistenceStore}. Caller JWT for list/validate. */
function buildResolveSkillStore<TTransaction>(options: {
  persistenceStore: ISkillStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
}): (requestContext: RequestContext) => ISkillStore<TTransaction> {
  const { persistenceStore, client } = options;
  if (client === undefined) {
    return () => persistenceStore;
  }
  return requestContext =>
    new TrueFoundrySkillStore<TTransaction>({
      client,
      context: requestContext,
    });
}

/**
 * Per-request model-provider store over a shared ServiceFoundry client, else {@link persistenceStore}.
 * `runAsAgent` is set only when a turn should use a saved agent's token.
 */
function buildResolveModelProviderStore<TTransaction>(options: {
  persistenceStore: IModelProviderStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
  logger: Logger;
}): (rc: RequestContext, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction> {
  return (rc, runAsAgent) => {
    const { persistenceStore, client } = options;
    if (client) {
      return new TrueFoundryModelProviderStore<TTransaction>({
        client,
        requestContext: rc,
        agent: runAsAgent,
        logger: options.logger,
      });
    }
    return persistenceStore;
  };
}

/**
 * Per-request MCP store over ServiceFoundry. `runAsAgent` selects a saved agent's token for turns.
 */
function buildResolveMcpServerStore<TTransaction>(options: {
  persistenceStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
  logger: Logger;
}): (
  rc: RequestContext,
  runAsAgent?: AgentRecord,
  perServerHeaders?: PerServerMcpHeaders,
) => IMcpServerWithAuthStore<TTransaction> {
  const withAuthMcpPersistenceStore = new McpServerWithAuthStore<TTransaction>({
    store: options.persistenceStore,
    tokenStore: options.tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  return (rc, runAsAgent, perServerHeaders) => {
    const { client } = options;
    if (client) {
      return new TrueFoundryMcpServerStore<TTransaction>({
        client,
        requestContext: rc,
        agent: runAsAgent,
        logger: options.logger,
        ...(perServerHeaders === undefined ? {} : { perServerHeaders }),
      });
    }
    return withAuthMcpPersistenceStore;
  };
}

/** Per-request agent store decorator over DB persistence, else {@link persistenceStore}. */
function buildResolveAgentStore(options: {
  persistenceStore: PostgresAgentStore;
  db: Kysely<PostgresDatabase>;
  client: TrueFoundryServiceFoundryServerClient | undefined;
}): (rc: RequestContext) => IAgentStore<Transaction<PostgresDatabase>> {
  const { persistenceStore, client, db } = options;
  return rc => {
    if (client) {
      return new TrueFoundryAgentStore({
        inner: persistenceStore,
        client,
        context: rc,
        db,
      });
    }
    return persistenceStore;
  };
}

/**
 * Sandbox-provider store resolver. In TrueFoundry mode the shared env-backed store is reused;
 * otherwise the persistence store is reused as-is.
 */
function buildResolveSandboxProviderStore<TTransaction>(options: {
  persistenceStore: ISandboxProviderStore<TTransaction>;
}): (rc: RequestContext) => ISandboxProviderStore<TTransaction> {
  const { persistenceStore } = options;
  if (isTrueFoundryModeEnabled(configuration)) {
    return () => new TrueFoundrySandboxProviderStore<TTransaction>();
  }
  return () => persistenceStore;
}

/** SQLite stores; Redis unused (executor peering disabled). */
async function createStandalonePersistence(options: {
  sqlitePath: string;
  logger: Logger;
}): Promise<ServerPersistence<Transaction<SqliteDatabase>>> {
  const { sqlitePath, logger } = options;
  await mkdir(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
  const [{ createSqliteDb }, { migrateSqliteToLatest }, sqliteStores] = await Promise.all([
    import('./db/sqlite/client'),
    import('./db/migrateSqlite'),
    Promise.all([
      import('./db/sqlite/session-store/SqliteSessionStore'),
      import('./db/sqlite/session-metrics/SqliteSessionMetricsStore'),
      import('./db/sqlite/model-provider-store/SqliteModelProviderStore'),
      import('./db/sqlite/mcp-server-store/SqliteMcpServerStore'),
      import('./db/sqlite/token-store/SqliteOAuthTokenStore'),
      import('./db/sqlite/skill-store/SqliteSkillStore'),
      import('./db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore'),
      import('./db/sqlite/agent-store/SqliteAgentStore'),
      import('./db/sqlite/schedule-store/SqliteScheduleStore'),
      import('./db/sqlite/personalization-store/SqlitePersonalizationStore'),
      import('./db/sqlite/persona-store/SqlitePersonaStore'),
      import('./db/sqlite/space-store/SqliteSpaceStore'),
      import('./db/sqlite/repository-store/SqliteRepositoryStore'),
      import('./db/sqlite/turn-artifact-store/SqliteTurnArtifactStore'),
      import('./db/sqlite/chat-image-store/SqliteChatImageStore'),
      import('./db/sqlite/global-settings-store/SqliteGlobalSettingsStore'),
      import('./db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore'),
      import('./db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore'),
      import('./db/sqlite/approval-token-store/SqliteApprovalTokenStore'),
      import('./db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore'),
      import('./db/sqlite/google-connection-store/SqliteGoogleConnectionStore'),
    ]),
  ]);
  const [
    { SqliteSessionStore },
    { SqliteSessionMetricsStore },
    { SqliteModelProviderStore },
    { SqliteMcpServerStore },
    { SqliteOAuthTokenStore },
    { SqliteSkillStore },
    { SqliteSandboxProviderStore },
    { SqliteAgentStore },
    { SqliteScheduleStore },
    { SqlitePersonalizationStore },
    { SqlitePersonaStore },
    { SqliteSpaceStore },
    { SqliteRepositoryStore },
    { SqliteTurnArtifactStore },
    { SqliteChatImageStore },
    { SqliteGlobalSettingsStore },
    { SqliteTokenFactoryUsageStore },
    { SqliteSentinelSettingsStore },
    { SqliteApprovalTokenStore },
    { SqliteMcpToolGrantStore },
    { SqliteGoogleConnectionStore },
  ] = sqliteStores;

  const db = createSqliteDb(sqlitePath);
  await migrateSqliteToLatest(db);
  logger.info(`Standalone mode: sqlite at ${sqlitePath}`);
  logger.info('Standalone mode: executor peering disabled and Redis unused');

  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const mcpServerStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const skillStore = new SqliteSkillStore(db);
  return {
    withTransaction: callback => db.transaction().execute(callback),
    skillStore,
    sandboxProviderStore,
    agentStore,
    personalizationStore: new SqlitePersonalizationStore(db),
    personaStore: new SqlitePersonaStore(db),
    spaceStore: new SqliteSpaceStore(db),
    repositoryStore: new SqliteRepositoryStore(db),
    sessionStore: new SqliteSessionStore(db),
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    mcpOAuthStore: mcpServerStore,
    tokenStore,
    scheduleStore: new SqliteScheduleStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    chatImageStore: new SqliteChatImageStore(db),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    tokenFactoryUsageStore: new SqliteTokenFactoryUsageStore(db),
    mcpToolGrantStore: new SqliteMcpToolGrantStore(db),
    googleConnectionStore: new SqliteGoogleConnectionStore(db),
    sentinelAuditStore: new SentinelAuditStore(db as Kysely<SentinelAuditDatabase>),
    sentinelSettingsStore: new SqliteSentinelSettingsStore(db),
    approvalTokenStore: new SqliteApprovalTokenStore(db),
    modelProviderStore,
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    destroyDb: () => db.destroy(),
    redis: undefined,
    serviceFoundryClient: undefined,
  };
}

/** Postgres stores + Redis for executor peering. */
async function createDistributedPersistence(options: {
  configuration: DistributedServerConfiguration;
  logger: Logger;
}): Promise<ServerPersistence<Transaction<PostgresDatabase>>> {
  const { configuration, logger } = options;
  const {
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: databasePoolMax,
    POSTGRES_STATEMENT_TIMEOUT_MS: statementTimeoutMs,
    POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: idleInTransactionSessionTimeoutMs,
    REDIS_URL: redisUrl,
    EXECUTOR_ID: executorId,
  } = configuration;

  const [{ createDb }, { migrateToLatest }, { connectRedis }, postgresStores] = await Promise.all([
    import('./db/postgres/client'),
    import('./db/migratePostgres'),
    import('./runtime/redis'),
    Promise.all([
      import('./db/postgres/session-store/PostgresSessionStore'),
      import('./db/postgres/session-metrics/PostgresSessionMetricsStore'),
      import('./db/postgres/model-provider-store/PostgresModelProviderStore'),
      import('./db/postgres/mcp-server-store/PostgresMcpServerStore'),
      import('./db/postgres/token-store/PostgresOAuthTokenStore'),
      import('./db/postgres/skill-store/PostgresSkillStore'),
      import('./db/postgres/sandbox-provider-store/PostgresSandboxProviderStore'),
      import('./db/postgres/agent-store/PostgresAgentStore'),
      import('./db/postgres/schedule-store/PostgresScheduleStore'),
      import('./db/postgres/personalization-store/PostgresPersonalizationStore'),
      import('./db/postgres/persona-store/PostgresPersonaStore'),
      import('./db/postgres/space-store/PostgresSpaceStore'),
      import('./db/postgres/repository-store/PostgresRepositoryStore'),
      import('./db/postgres/turn-artifact-store/PostgresTurnArtifactStore'),
      import('./db/postgres/chat-image-store/PostgresChatImageStore'),
      import('./db/postgres/global-settings-store/PostgresGlobalSettingsStore'),
      import('./db/postgres/token-factory-usage-store/PostgresTokenFactoryUsageStore'),
      import('./db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore'),
      import('./db/postgres/approval-token-store/PostgresApprovalTokenStore'),
      import('./db/postgres/mcp-tool-grant-store/PostgresMcpToolGrantStore'),
      import('./db/postgres/google-connection-store/PostgresGoogleConnectionStore'),
    ]),
  ]);
  const [
    { PostgresSessionStore },
    { PostgresSessionMetricsStore },
    { PostgresModelProviderStore },
    { PostgresMcpServerStore },
    { PostgresOAuthTokenStore },
    { PostgresSkillStore },
    { PostgresSandboxProviderStore },
    { PostgresAgentStore },
    { PostgresScheduleStore },
    { PostgresPersonalizationStore },
    { PostgresPersonaStore },
    { PostgresSpaceStore },
    { PostgresRepositoryStore },
    { PostgresTurnArtifactStore },
    { PostgresChatImageStore },
    { PostgresGlobalSettingsStore },
    { PostgresTokenFactoryUsageStore },
    { PostgresSentinelSettingsStore },
    { PostgresApprovalTokenStore },
    { PostgresMcpToolGrantStore },
    { PostgresGoogleConnectionStore },
  ] = postgresStores;

  const db = createDb({
    connectionString: databaseUrl,
    poolMax: databasePoolMax,
    statementTimeoutMs,
    idleInTransactionSessionTimeoutMs,
  });
  await migrateToLatest(db);
  logger.info('Distributed mode: postgres');
  if (isPlaceholderTrueForgeApiKey(configuration.TRUEFORGE_API_KEY)) {
    logger.warn('TRUEFORGE_API_KEY is a well-known placeholder; set a real key before any shared deployment');
  }
  logger.info(`Executor id: ${executorId}`);
  const serviceFoundryClient = createServiceFoundryServerClient(logger);
  const tokenStore = new PostgresOAuthTokenStore(db);
  const modelProviderStore = new PostgresModelProviderStore(db);
  const mcpServerStore = new PostgresMcpServerStore(db);
  const mcpServerWithAuthStore = new McpServerWithAuthStore({
    store: mcpServerStore,
    tokenStore,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
  });
  const sandboxProviderStore = new PostgresSandboxProviderStore(db);
  const skillStore = new PostgresSkillStore(db);
  const agentStore = new PostgresAgentStore(db);
  const resolveModelProviderStore = buildResolveModelProviderStore({
    persistenceStore: modelProviderStore,
    client: serviceFoundryClient,
    logger,
  });
  const resolveMcpServerStore = buildResolveMcpServerStore({
    persistenceStore: mcpServerStore,
    tokenStore,
    client: serviceFoundryClient,
    logger,
  });
  const resolveAgentStore = buildResolveAgentStore({
    persistenceStore: agentStore,
    db,
    client: serviceFoundryClient,
  });
  const resolveImportAgentStore = (
    serviceFoundryServerHeaders: Record<string, string>,
  ): IAgentStore<Transaction<PostgresDatabase>> => {
    const client = createServiceFoundryServerClient(logger, serviceFoundryServerHeaders);
    if (client === undefined) {
      return agentStore;
    }
    return new TrueFoundryAgentStore({
      inner: agentStore,
      client,
      context: {
        tenant_id: 'system',
        subject: { id: 'tfy-system', type: 'serviceaccount', display_name: 'tfy-system' },
        roles: [],
        user_credential: client.apiKey,
      },
      db,
    });
  };
  const resolveSandboxProviderStore = buildResolveSandboxProviderStore({
    persistenceStore: sandboxProviderStore,
  });
  const resolveSkillStore = buildResolveSkillStore({
    persistenceStore: skillStore,
    client: serviceFoundryClient,
  });
  return {
    withTransaction: callback => db.transaction().execute(callback),
    skillStore,
    sandboxProviderStore,
    agentStore,
    personalizationStore: new PostgresPersonalizationStore(db),
    personaStore: new PostgresPersonaStore(db),
    spaceStore: new PostgresSpaceStore(db),
    repositoryStore: new PostgresRepositoryStore(db),
    sessionStore: new PostgresSessionStore(db),
    sessionMetricsStore: new PostgresSessionMetricsStore(db),
    mcpOAuthStore: mcpServerWithAuthStore,
    tokenStore,
    scheduleStore: new PostgresScheduleStore(db),
    turnArtifactStore: new PostgresTurnArtifactStore(db),
    chatImageStore: new PostgresChatImageStore(db),
    globalSettingsStore: new PostgresGlobalSettingsStore(db),
    tokenFactoryUsageStore: new PostgresTokenFactoryUsageStore(db),
    mcpToolGrantStore: new PostgresMcpToolGrantStore(db),
    googleConnectionStore: new PostgresGoogleConnectionStore(db),
    sentinelAuditStore: new SentinelAuditStore(db as Kysely<SentinelAuditDatabase>),
    sentinelSettingsStore: new PostgresSentinelSettingsStore(db),
    approvalTokenStore: new PostgresApprovalTokenStore(db),
    modelProviderStore,
    resolveModelProviderStore,
    resolveMcpServerStore,
    resolveSandboxProviderStore,
    resolveSkillStore,
    resolveAgentStore,
    resolveImportAgentStore,
    destroyDb: () => db.destroy(),
    redis: await connectRedis({ url: redisUrl, logger }),
    serviceFoundryClient,
  };
}

/** Keeps `TTransaction` concrete when wiring a single persistence topology into the app. */
async function createServerRuntime<TTransaction>(persistence: ServerPersistence<TTransaction>, logger: Logger) {
  const {
    withTransaction,
    sessionStore,
    sessionMetricsStore,
    tokenStore,
    scheduleStore,
    mcpOAuthStore,
    modelProviderStore,
    resolveImportAgentStore,
    agentStore,
    skillStore,
    sandboxProviderStore,
    personalizationStore,
    personaStore,
    spaceStore,
    repositoryStore,
    turnArtifactStore,
    chatImageStore,
    globalSettingsStore,
    tokenFactoryUsageStore,
    mcpToolGrantStore,
    googleConnectionStore,
    sentinelAuditStore,
    sentinelSettingsStore,
    approvalTokenStore,
    destroyDb,
    redis,
    serviceFoundryClient,
  } = persistence;

  // The env-managed Token Factory provider and default model are written before the first request,
  // so no Settings step is needed. TrueFoundry mode lists providers from TrueFoundry instead.
  if (!isTrueFoundryModeEnabled(configuration)) {
    const outcome = await ensureEnvManagedTokenFactoryProvider({
      store: modelProviderStore,
      tenant_id: TENANT_ID,
      settings: {
        apiKey: configuration.NEBIUS_API_KEY,
        baseUrl: configuration.TOKEN_FACTORY_BASE_URL,
        model: configuration.TOKEN_FACTORY_MODEL,
        cheaperModel: configuration.TOKEN_FACTORY_CHEAPER_MODEL,
      },
      logger,
    });
    if (outcome !== 'skipped') {
      await seedEnvManagedDefaultChatModel({
        globalSettingsStore,
        model: configuration.TOKEN_FACTORY_MODEL,
        logger,
      });
    }
  }
  const tokenFactoryBudget = createTokenFactoryBudget({
    store: tokenFactoryUsageStore,
    cap: configuration.TOKEN_FACTORY_DAILY_TOKEN_CAP,
  });

  if (redis === undefined) {
    const recoveredCommandExecutions = await sessionStore.recoverRunningCommandExecutions({
      completed_at: new Date(),
      owner_ids: null,
      require_expired_lease: true,
    });
    if (recoveredCommandExecutions > 0) {
      logger.warn('Recovered registered commands left running by a previous server process', {
        count: recoveredCommandExecutions,
        disposition: 'outcome_unknown',
      });
    }
  }

  const activeTurns = new ActiveTurnRegistry();
  const turnDrains = new TurnDrainRegistry();
  const requestReplyRouter = new RequestReplyRouter();
  const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(redis);
  const outboundSecrets = createOutboundSecretSource({
    configured: () => getConfiguredSecretValues(configuration),
    modelProviders: modelProviderStore,
    sandboxProviders: sandboxProviderStore,
    mcpServers: mcpOAuthStore,
    tokens: tokenStore,
    googleConnections: googleConnectionStore,
  });
  const sentinelServices = createSentinelServices({
    audit: sentinelAuditStore,
    settings: sentinelSettingsStore,
    approvalTokens: approvalTokenStore,
    toolGrants: mcpToolGrantStore,
    outboundSecrets,
  });
  const sessions = new Sessions({ sessionStore, sentinelServices });
  const chatImages = createChatImageService({
    store: chatImageStore,
    sessionStore,
    turnArtifactStore,
    reencode: createImageReencoder({
      resolveSandbox: () => (slotsBackendEnabled() ? getSharedRunCodeService(logger) : null),
    }),
    sentinel: sentinelServices,
    fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
  });

  const oidc = isOidcConfigured(configuration) ? configuration.OIDC : undefined;
  if (oidc) {
    logger.info('Auth is enabled', { issuer: oidc.OIDC_ISSUER_URL });
  } else {
    logger.warn('Auth is disabled; browser login is off');
  }
  const oidcDiscovery = oidc ? startOidcDiscovery({ oidc, logger }) : undefined;

  let authenticator;
  let authorizer: Authorizer;
  const mode = getTrueForgeAuthMode(configuration);
  if (mode === TrueForgeAuthMode.TrueFoundry) {
    if (serviceFoundryClient === undefined) {
      throw new Error('TrueFoundry mode requires TRUEFOUNDRY_SERVICEFOUNDRY_SERVER_URL');
    }
    authenticator = createAuthenticator({
      mode: TrueForgeAuthMode.TrueFoundry,
      serviceFoundryClient,
    });
    authorizer = new TrueFoundryAuthorizer(serviceFoundryClient);
  } else if (mode === TrueForgeAuthMode.Oidc) {
    authenticator = createAuthenticator({ mode: TrueForgeAuthMode.Oidc });
    authorizer = new TrueForgeAuthorizer();
  } else {
    authenticator = createAuthenticator({ mode: TrueForgeAuthMode.Standalone });
    authorizer = new TrueForgeAuthorizer();
  }

  // Standalone owns the control loops in-process; they hand off via HTTP loopback
  // (same transport as the dedicated controller in distributed mode).
  const controller = configuration.STANDALONE
    ? createController({
        scheduleStore,
        withTransaction,
        logger,
      })
    : undefined;

  // Hono handlers get Context; persistence resolvers take RequestContext.
  const resolveModelProviderStore = (c: Context, runAsAgent?: AgentRecord) =>
    persistence.resolveModelProviderStore(resolveRequestContext(c), runAsAgent);
  const resolveMcpServerStore = (c?: Context, runAsAgent?: AgentRecord) => {
    if (c === undefined) {
      return mcpOAuthStore;
    }
    const rawPerServerHeaders = c.req.header(X_TFG_MCP_HEADERS);
    return persistence.resolveMcpServerStore(
      resolveRequestContext(c),
      runAsAgent,
      rawPerServerHeaders === undefined ? undefined : parsePerServerMcpHeaders(rawPerServerHeaders),
    );
  };
  const resolveAgentStore = (c: Context) => persistence.resolveAgentStore(resolveRequestContext(c));
  const resolveSandboxProviderStore = (c: Context) => persistence.resolveSandboxProviderStore(resolveRequestContext(c));
  const resolveSkillStore = (c: Context) => persistence.resolveSkillStore(resolveRequestContext(c));
  const app = createServerApp({
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    resolveModelProviderStore,
    resolveMcpServerStore,
    resolveAgentStore,
    resolveImportAgentStore,
    resolveSandboxProviderStore,
    resolveSkillStore,
    withTransaction,
    tokenStore,
    mcpToolGrantStore,
    googleConnectionStore,
    scheduleStore,
    agentStore,
    skillStore,
    sandboxProviderStore,
    personalizationStore,
    personaStore,
    spaceStore,
    repositoryStore,
    turnArtifactStore,
    globalSettingsStore,
    tokenFactoryBudget,
    sessionStore,
    sessionMetricsStore,
    sentinelAuditStore,
    sentinelSettingsStore,
    sessions,
    chatImages,
    activeTurns,
    turnDrains,
    redis,
    requestReplyRouter,
    eventSubscriptions,
    logger,
    oidcDiscovery,
    authenticator,
    authorizer,
    outboundSecrets,
  });

  return {
    activeTurns,
    app,
    controller,
    oidcDiscovery,
    destroyDb,
    googleConnectionStore,
    redis,
    requestReplyRouter,
    sessionStore,
    turnArtifactStore,
    chatImageStore,
    turnDrains,
  };
}

try {
  const logger = createServerLogger({
    level: configuration.LOG_LEVEL,
    standalone: configuration.STANDALONE,
    version: PACKAGE_VERSION,
  });

  // Fail closed before anything is created: standalone never starts without login.
  // Any CLI subcommand is dispatched in cli.ts before this module is imported, so it never reaches this check.
  assertNetworkAuthRequirement({
    authMode: getTrueForgeAuthMode(configuration),
    standalone: configuration.STANDALONE,
    host: configuration.HOST,
    requireAuth: configuration.REQUIRE_AUTH,
  });

  // Fail fast on unwritable data directories: the persona knowledge library and
  // (with the markdown backend) the memory store write here at query time, and
  // a bare EACCES mid-request is a silent production outage. This throws a
  // configuration-shaped error naming the env var instead.
  await ensureWritableDataDir({
    dir: configuration.PERSONA_KNOWLEDGE_DIR,
    envVar: 'PERSONA_KNOWLEDGE_DIR',
  });
  if (configuration.MEMORY_BACKEND === 'markdown') {
    await ensureWritableDataDir({
      dir: configuration.MEMORY_MARKDOWN_DIR,
      envVar: 'MEMORY_MARKDOWN_DIR',
    });
  }

  if (configuration.STANDALONE) {
    printStandaloneStartupBanner({ version: PACKAGE_VERSION, color: shouldColorize() });
    await prepareCodeModeSocketParent({
      path: configuration.CODE_MODE_SOCKET_PARENT,
      logger,
      port: configuration.PORT,
    });
    await ensureLocalSandboxRootParent(configuration.LOCAL_SANDBOX_ROOT_PARENT);
    const { LocalSandboxProvider } = await import('./sandbox/local/provider/LocalSandboxProvider');
    const support = await LocalSandboxProvider.isSupported({
      codeModeSocketParentPath: configuration.CODE_MODE_SOCKET_PARENT,
    });
    setCachedLocalSandboxSupport(support);
    if (support.supported) {
      logger.info('Local sandbox fallback is available', {
        platform: support.platform,
        shell: support.shell,
        python: support.python,
      });
    } else {
      logger.warn('Local sandbox fallback is unavailable', {
        reason: support.reason,
        ...(support.platform === undefined ? {} : { platform: support.platform }),
        ...(support.attempts === undefined ? {} : { attempts: support.attempts }),
      });
    }
  } else {
    logger.info('TrueForge starting', { mode: 'distributed' });
  }

  const {
    activeTurns,
    app,
    controller,
    oidcDiscovery,
    destroyDb,
    googleConnectionStore,
    redis,
    requestReplyRouter,
    sessionStore,
    turnArtifactStore,
    chatImageStore,
    turnDrains,
  } = configuration.STANDALONE
    ? await createServerRuntime(
        await createStandalonePersistence({ sqlitePath: configuration.SQLITE_PATH, logger }),
        logger,
      )
    : await createServerRuntime(await createDistributedPersistence({ configuration, logger }), logger);

  // Turn artifact retention: persisted run_code/sandbox result files are
  // downloads, not a permanent archive. One startup-anchored sweep a day
  // deletes index rows older than TURN_ARTIFACT_RETENTION_DAYS plus blobs no
  // surviving row references, and chat images past their retention.
  // Best effort: failures are logged, never fatal.
  let artifactRetentionInFlight = false;
  const sweepExpiredTurnArtifacts = async (): Promise<void> => {
    if (artifactRetentionInFlight) {
      return;
    }
    artifactRetentionInFlight = true;
    try {
      const deleted = await turnArtifactStore.deleteArtifactsOlderThan({
        older_than: new Date(Date.now() - configuration.TURN_ARTIFACT_RETENTION_DAYS * 86_400_000).toISOString(),
      });
      if (deleted > 0) {
        logger.info('Deleted expired turn artifact rows', { count: deleted });
      }
      const deletedImages = await chatImageStore.deleteImagesOlderThan({
        older_than: new Date(Date.now() - CHAT_IMAGE_RETENTION_DAYS * 86_400_000).toISOString(),
      });
      if (deletedImages > 0) {
        logger.info('Deleted expired chat images', { count: deletedImages });
      }
    } catch (error) {
      logger.warn('Turn artifact retention sweep failed', extractErrorLogFields(error));
    } finally {
      artifactRetentionInFlight = false;
    }
  };
  void sweepExpiredTurnArtifacts();
  const artifactRetentionTimer = setInterval(() => {
    void sweepExpiredTurnArtifacts();
  }, 86_400_000);
  artifactRetentionTimer.unref();

  // Abandoned Google consents hold a client secret; consent reads already purge, this covers an idle install.
  const googlePendingPurgeTimer = setInterval(() => {
    googleConnectionStore.purgeExpiredPending().catch((error: unknown) => {
      logger.warn('Google pending consent purge failed', extractErrorLogFields(error));
    });
  }, 300_000);
  googlePendingPurgeTimer.unref();

  if (
    mountFrontend(app, {
      dir: configuration.FRONTEND_DIR,
      uiBasePath: getPublicUiBasePath(),
    })
  ) {
    logger.info(`Serving frontend from ${configuration.FRONTEND_DIR}`);
  } else {
    logger.warn(
      `No frontend build at ${configuration.FRONTEND_DIR}: serving the API only. ` +
        'Run `pnpm --filter frontend build` (and copy via build:frontend-assets) to serve the UI, or `pnpm standalone:dev` / `pnpm dev` for Vite.',
    );
  }

  // After createServerApp so every request-reply route is registered before
  // the executor starts consuming messages. The executor needs a dedicated
  // subscriber connection (a subscribed client cannot issue normal commands);
  // this process owns its lifecycle. Connect before init() so init() awaits
  // the initial subscribe + heartbeat — the replica is reachable for peering
  // before the HTTP server starts.
  let requestReplySubscriber: RedisClientType | undefined;
  let requestReplyExecutor: RequestReplyExecutor | undefined;
  let commandExecutionRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  if (redis) {
    requestReplySubscriber = redis.duplicate();
    requestReplySubscriber.on('error', (error: Error) => {
      logger.error('[RedisSubscriber] Client error', extractErrorLogFields(error));
    });
    await requestReplySubscriber.connect();
    requestReplyExecutor = new RequestReplyExecutor({
      executorId: configuration.EXECUTOR_ID,
      redis,
      subscriberClient: requestReplySubscriber,
      requestHandler: requestReplyRouter.createRequestHandler(),
      logger,
      options: {
        heartbeatIntervalMs: configuration.REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS,
        replyTtlMs: configuration.REDIS_REQUEST_REPLY_REPLY_TTL_MS,
      },
    });
    await requestReplyExecutor.init();

    let recoveryInFlight = false;
    const recoverStaleCommandExecutions = async (): Promise<void> => {
      if (recoveryInFlight) {
        return;
      }
      recoveryInFlight = true;
      try {
        const recovery = await recoverAbandonedCommandExecutions({
          store: sessionStore,
          isExecutorAlive: async executorId => (await redis.exists(heartbeatKey(executorId))) > 0,
          completedAt: new Date(),
        });
        if (recovery.recovered > 0) {
          logger.warn('Recovered registered commands owned by unavailable executors', {
            count: recovery.recovered,
            ownerIds: recovery.staleOwnerIds,
            disposition: 'outcome_unknown',
          });
        }
      } catch (error) {
        logger.warn(
          'Skipped registered command recovery because executor liveness could not be established',
          extractErrorLogFields(error),
        );
      } finally {
        recoveryInFlight = false;
      }
    };
    await recoverStaleCommandExecutions();
    const recoveryIntervalMs = Math.max(
      10_000,
      Math.ceil(configuration.REDIS_REQUEST_REPLY_HEARTBEAT_INTERVAL_MS * 1.5) + 1_000,
    );
    commandExecutionRecoveryTimer = setInterval(() => {
      void recoverStaleCommandExecutions();
    }, recoveryIntervalMs);
    commandExecutionRecoveryTimer.unref();
  } else {
    let standaloneRecoveryInFlight = false;
    const recoverExpiredStandaloneCommands = async (): Promise<void> => {
      if (standaloneRecoveryInFlight) {
        return;
      }
      standaloneRecoveryInFlight = true;
      try {
        const recovered = await sessionStore.recoverRunningCommandExecutions({
          completed_at: new Date(),
          owner_ids: null,
          require_expired_lease: true,
        });
        if (recovered > 0) {
          logger.warn('Recovered registered commands whose standalone ownership leases expired', {
            count: recovered,
            disposition: 'outcome_unknown',
          });
        }
      } catch (error) {
        logger.warn('Skipped standalone registered command recovery', extractErrorLogFields(error));
      } finally {
        standaloneRecoveryInFlight = false;
      }
    };
    commandExecutionRecoveryTimer = setInterval(() => {
      void recoverExpiredStandaloneCommands();
    }, 10_000);
    commandExecutionRecoveryTimer.unref();
  }

  const tlsServe = serverTlsServeOptions({
    enabled: !configuration.STANDALONE && configuration.TRUEFORGE_MTLS_ENABLED,
    dir: configuration.TRUEFORGE_MTLS_CERTS_DIR,
  });

  // Smart search warms in the background at boot instead of on first use: the embedding
  // model (~120 MB) starts downloading immediately, and the default tenant's memories
  // index as soon as it is ready — so the Settings badge usually moves off "Starting"
  // on its own before the first chat turn. Fire-and-forget: startup never waits, a
  // failure degrades to keyword search with the usual cooldown retry, and other
  // tenants warm on first use reusing the shared download.
  if (configuration.MEMORY_EMBEDDINGS_ENABLED && configuration.MEMORY_BACKEND === 'markdown') {
    warmEmbeddingsAtBoot({
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      namespace: TENANT_ID,
      modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
      batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
      log: message => logger.info(message),
    });
  }

  // Voice input availability is probed in the background at boot instead of on
  // first use: the STT sidecar `/healthz` check runs immediately without blocking
  // startup, then repeats every 30s, so `capabilities.voice` flips on as soon as
  // the sidecar is warm and recovers without a backend restart. The check is
  // advisory only; the backend boots regardless of STT state.
  startSttAvailabilityWatcher({ logger });

  const server = serve(
    {
      fetch: app.fetch,
      port: configuration.PORT,
      hostname: configuration.HOST,
      ...(tlsServe ?? {}),
    },
    info => {
      const scheme = tlsServe !== undefined ? 'https' : 'http';
      logger.info(
        `Agent server listening on ${scheme}://${configuration.HOST}:${String(info.port)} (docs at /api/v1/docs)`,
      );
      // The controller calls this server over HTTP(S).
      controller?.start();
    },
  );

  server.on('error', (error: unknown) => {
    console.error('Failed to start server:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

  // Graceful drain is the safe default for built and direct execution.
  // Development watch mode opts out so tsx can restart without waiting for a drain.
  if (configuration.NODE_ENV !== 'development') {
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info(`Received ${signal}, draining connections before shutdown`);

      // Arm at the start of each shutdown; unref so this timer alone cannot keep the process alive.
      setTimeout(() => {
        logger.warn(`Drain timed out after ${String(configuration.GRACEFUL_TIMEOUT_SECONDS)}s, exiting`);
        process.exit(1);
      }, configuration.GRACEFUL_TIMEOUT_SECONDS * 1000).unref();

      const closed = new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      });

      // Stop the control loops before draining; anything they already started drains
      // with every other turn below.
      await controller?.stop();

      // Sets the registry's shutdown reason immediately so late track() (in-flight create-turn still
      // inside session.createTurn) aborts as Abandoned; then drains the registry. await
      // closed covers the gap where the registry is empty before that late track().
      await activeTurns.shutdownAndWait(CancellationReason.Abandoned);
      await closed;
      // Wait for detached turn drains (memory retain, profile learning, artifact persistence)
      // with a bounded timeout so a stuck provider call cannot hang shutdown forever. This
      // runs before the Redis/DB teardown below because drains still dual-write events.
      if (turnDrains.size > 0) {
        logger.info(`Waiting for ${String(turnDrains.size)} in-flight turn drains before shutdown`);
      }
      await turnDrains.shutdownAndWait({ timeoutMs: configuration.TURN_DRAIN_SHUTDOWN_TIMEOUT_MS });
      clearInterval(commandExecutionRecoveryTimer);
      clearInterval(artifactRetentionTimer);
      oidcDiscovery?.stop();
      clearInterval(googlePendingPurgeTimer);
      // Stop serving peer requests (waits for in-flight replies), then close
      // the clients this process owns: the subscriber duplicate and the primary.
      await requestReplyExecutor?.drain();
      await requestReplySubscriber?.close().catch((error: unknown) => {
        logger.warn('[Redis] Error closing subscriber client during shutdown', extractErrorLogFields(error));
      });
      await redis?.close().catch((error: unknown) => {
        logger.warn('[Redis] Error closing client during shutdown', extractErrorLogFields(error));
      });
      if (configuration.STANDALONE) {
        await removeCodeModeSocketParent(configuration.CODE_MODE_SOCKET_PARENT).catch((error: unknown) => {
          logger.warn('Error removing Code Mode socket parent during shutdown', extractErrorLogFields(error));
        });
      }
      await destroyDb();
      process.exit(0);
    };
    process.on('SIGTERM', signal => {
      void shutdown(signal);
    });
    process.on('SIGINT', signal => {
      void shutdown(signal);
    });
  }
} catch (error) {
  console.error('Failed to start server:', error instanceof Error ? error.message : error);
  process.exit(1);
}
