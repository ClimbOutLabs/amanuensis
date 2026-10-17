/**
 * Boots the real server app over SQLite or Postgres with a header-named caller, so the two-user ownership suite
 * drives the whole HTTP surface on either engine. A separate fixture from `approvalTestServer` keeps that one
 * SQLite-only; callers are named by `x-test-user` and nobody is admin unless listed.
 */
import { Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { HTTPException } from 'hono/http-exception';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import { createServerApp, type ServerDeps } from '../../src/app';
import type { Authenticator } from '../../src/auth/authenticator';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import type { RequestContext } from '../../src/auth/identity';
import { McpCatalog } from '../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../src/catalog/SkillCatalog';
import type { IMcpServerStore } from '../../src/db/mcpServerStore';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import type { IModelProviderStore } from '../../src/db/modelProviderStore';
import { PostgresAgentStore } from '../../src/db/postgres/agent-store/PostgresAgentStore';
import { PostgresApprovalTokenStore } from '../../src/db/postgres/approval-token-store/PostgresApprovalTokenStore';
import { PostgresChatImageStore } from '../../src/db/postgres/chat-image-store/PostgresChatImageStore';
import { PostgresGlobalSettingsStore } from '../../src/db/postgres/global-settings-store/PostgresGlobalSettingsStore';
import { PostgresMcpServerStore } from '../../src/db/postgres/mcp-server-store/PostgresMcpServerStore';
import { PostgresMcpToolGrantStore } from '../../src/db/postgres/mcp-tool-grant-store/PostgresMcpToolGrantStore';
import { PostgresModelProviderStore } from '../../src/db/postgres/model-provider-store/PostgresModelProviderStore';
import { PostgresPersonaStore } from '../../src/db/postgres/persona-store/PostgresPersonaStore';
import { PostgresPersonalizationStore } from '../../src/db/postgres/personalization-store/PostgresPersonalizationStore';
import { PostgresRepositoryStore } from '../../src/db/postgres/repository-store/PostgresRepositoryStore';
import { PostgresSandboxProviderStore } from '../../src/db/postgres/sandbox-provider-store/PostgresSandboxProviderStore';
import { PostgresScheduleStore } from '../../src/db/postgres/schedule-store/PostgresScheduleStore';
import { PostgresSentinelSettingsStore } from '../../src/db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { PostgresSessionMetricsStore } from '../../src/db/postgres/session-metrics/PostgresSessionMetricsStore';
import { PostgresSessionStore } from '../../src/db/postgres/session-store/PostgresSessionStore';
import { PostgresSkillStore } from '../../src/db/postgres/skill-store/PostgresSkillStore';
import { PostgresSpaceStore } from '../../src/db/postgres/space-store/PostgresSpaceStore';
import { PostgresOAuthTokenStore } from '../../src/db/postgres/token-store/PostgresOAuthTokenStore';
import { PostgresTurnArtifactStore } from '../../src/db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import { SentinelAuditStore } from '../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteApprovalTokenStore } from '../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { SqliteChatImageStore } from '../../src/db/sqlite/chat-image-store/SqliteChatImageStore';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
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
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { createChatImageService } from '../../src/runtime/chatImages/chatImageService';
import { createImageReencoder } from '../../src/runtime/chatImages/reencodeInSandbox';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { createOutboundSecretSource } from '../../src/runtime/outboundSecrets';
import { createSentinelServices } from '../../src/runtime/sentinelServices';
import { TurnDrainRegistry } from '../../src/runtime/turnDrains';
import { TENANT_ID } from '../../src/tenancy';
import { createPostgresTestDatabase } from '../db/postgres/testDatabase';
import { INERT_SERVER_NAME, startInertMcpServer, type InertMcpServer } from './inertMcpServer';
import { startScriptedModelServer, type ScriptedModelServer } from './scriptedModelServer';
import { uncappedTokenFactoryBudget } from './uncappedTokenFactoryBudget';

export type OwnershipEngine = 'sqlite' | 'postgres';

export const MODEL_PROVIDER_NAME = 'scripted';
export const MODEL_FQN = `${MODEL_PROVIDER_NAME}/scripted-model`;

export interface OwnershipServer {
  /** Sends one request through the mounted app as `user`; `path` is a full API path. */
  request: (input: { user: string; path: string; method?: string; json?: unknown }) => Promise<Response>;
  /** The mounted routes, as `METHOD /path` with `:param` segments, for the sign-in sweep. */
  routes: { method: string; path: string }[];
  /** The inert connector, to prove a refused call never ran its tools. */
  mcp: InertMcpServer;
  /** The scripted model, to prove what a turn put in front of the model. */
  model: ScriptedModelServer;
  /** The same app with no credential at all. */
  requestAnonymous: (input: { path: string; method?: string }) => Promise<Response>;
  close: () => Promise<void>;
}

export const ADMIN_USER = 'admin@example.test';

/** The caller is named by `x-test-user`; a missing header is an anonymous request. */
const headerAuthenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    const context: RequestContext = {
      tenant_id: 'default',
      subject: { id: user, type: 'user', display_name: user },
      roles: user === ADMIN_USER ? ['admin'] : [],
      user_credential: null,
    };
    return Promise.resolve(context);
  },
};

type SharedDeps = Pick<
  ServerDeps<never>,
  | 'modelCatalog'
  | 'mcpCatalog'
  | 'skillCatalog'
  | 'sandboxCatalog'
  | 'tokenFactoryBudget'
  | 'activeTurns'
  | 'turnDrains'
  | 'requestReplyRouter'
  | 'eventSubscriptions'
  | 'logger'
  | 'oidcDiscovery'
  | 'authenticator'
  | 'authorizer'
>;

function sharedDeps(): SharedDeps {
  return {
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    activeTurns: new ActiveTurnRegistry(),
    turnDrains: new TurnDrainRegistry(),
    requestReplyRouter: new RequestReplyRouter(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger: createLogger({ silent: true }),
    oidcDiscovery: undefined,
    authenticator: headerAuthenticator,
    authorizer: new TrueForgeAuthorizer(),
  };
}

/** The scripted model and the inert connector every session in the suite uses. */
async function seedBackends({
  modelProviders,
  mcpServers,
}: {
  modelProviders: IModelProviderStore<unknown>;
  mcpServers: IMcpServerStore<unknown>;
}): Promise<{ model: ScriptedModelServer; mcp: InertMcpServer }> {
  const mcp = await startInertMcpServer();
  const model = await startScriptedModelServer();
  await modelProviders.upsertProvider({
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
          properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['none'] },
        },
      ],
    },
  });
  await mcpServers.upsertServer({
    tenant_id: TENANT_ID,
    name: INERT_SERVER_NAME,
    manifest: { type: 'remote', name: INERT_SERVER_NAME, url: mcp.url, description: 'Inert connector.' },
    first_party: false,
  });
  return { model, mcp };
}

function wrap({
  app,
  backends,
  close,
}: {
  app: ReturnType<typeof createServerApp>;
  backends: { model: ScriptedModelServer; mcp: InertMcpServer };
  close: () => Promise<void>;
}): OwnershipServer {
  return {
    request: async ({ user, path, method, json }) => {
      const headers = new Headers({ 'x-test-user': user });
      if (json !== undefined) {
        headers.set('content-type', 'application/json');
      }
      const body = json === undefined ? undefined : JSON.stringify(json);
      return await app.request(path, { method: method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
    },
    routes: app.routes.filter(route => route.method !== 'ALL').map(({ method, path }) => ({ method, path })),
    mcp: backends.mcp,
    model: backends.model,
    requestAnonymous: async ({ path, method }) => await app.request(path, { method: method ?? 'GET' }),
    close: async () => {
      await close();
      await backends.model.close();
      await backends.mcp.close();
    },
  };
}

async function startSqlite(): Promise<OwnershipServer> {
  const directory = await mkdtemp(join(tmpdir(), 'tfy-ownership-'));
  const db = createSqliteDb(join(directory, 'ownership.sqlite'));
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const agentStore = new SqliteAgentStore(db);
  const modelProviderStore = new SqliteModelProviderStore(db);
  const mcpServerStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore,
    clientName: 'ownership-test-fixture',
  });
  const sandboxProviderStore = new SqliteSandboxProviderStore(db);
  const skillStore = new SqliteSkillStore(db);
  const sentinelAuditStore = new SentinelAuditStore(db);
  const sentinelSettingsStore = new SqliteSentinelSettingsStore(db);
  const mcpToolGrantStore = new SqliteMcpToolGrantStore(db);
  const sentinelServices = createSentinelServices({
    audit: sentinelAuditStore,
    settings: sentinelSettingsStore,
    approvalTokens: new SqliteApprovalTokenStore(db),
    toolGrants: mcpToolGrantStore,
    outboundSecrets: createOutboundSecretSource({
      configured: () => [],
      modelProviders: modelProviderStore,
      sandboxProviders: sandboxProviderStore,
      mcpServers: mcpServerStore,
      tokens: tokenStore,
    }),
  });
  const backends = await seedBackends({
    modelProviders: modelProviderStore,
    mcpServers: new SqliteMcpServerStore(db),
  });
  const app = createServerApp({
    ...sharedDeps(),
    withTransaction: callback => db.transaction().execute(callback),
    tokenStore,
    mcpToolGrantStore,
    skillStore,
    sandboxProviderStore,
    agentStore,
    personalizationStore: new SqlitePersonalizationStore(db),
    personaStore: new SqlitePersonaStore(db),
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
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    sessionStore,
    sentinelAuditStore,
    sentinelSettingsStore,
    sessions: new Sessions({ sessionStore, sentinelServices }),
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
  });
  return wrap({
    app,
    backends,
    close: async () => {
      await db.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  });
}

/** Undefined when no Postgres is reachable, so the suite can skip like the other Postgres store suites. */
async function startPostgres(): Promise<OwnershipServer | undefined> {
  const database = await createPostgresTestDatabase();
  if (database === undefined) {
    return undefined;
  }
  const { db } = database;
  const sessionStore = new PostgresSessionStore(db);
  const tokenStore = new PostgresOAuthTokenStore(db);
  const agentStore = new PostgresAgentStore(db);
  const modelProviderStore = new PostgresModelProviderStore(db);
  const mcpServerStore = new McpServerWithAuthStore({
    store: new PostgresMcpServerStore(db),
    tokenStore,
    clientName: 'ownership-test-fixture',
  });
  const sandboxProviderStore = new PostgresSandboxProviderStore(db);
  const skillStore = new PostgresSkillStore(db);
  const sentinelAuditStore = new SentinelAuditStore(db);
  const sentinelSettingsStore = new PostgresSentinelSettingsStore(db);
  const mcpToolGrantStore = new PostgresMcpToolGrantStore(db);
  const sentinelServices = createSentinelServices({
    audit: sentinelAuditStore,
    settings: sentinelSettingsStore,
    approvalTokens: new PostgresApprovalTokenStore(db),
    toolGrants: mcpToolGrantStore,
    outboundSecrets: createOutboundSecretSource({
      configured: () => [],
      modelProviders: modelProviderStore,
      sandboxProviders: sandboxProviderStore,
      mcpServers: mcpServerStore,
      tokens: tokenStore,
    }),
  });
  const backends = await seedBackends({
    modelProviders: modelProviderStore,
    mcpServers: new PostgresMcpServerStore(db),
  });
  const app = createServerApp({
    ...sharedDeps(),
    withTransaction: callback => db.transaction().execute(callback),
    tokenStore,
    mcpToolGrantStore,
    skillStore,
    sandboxProviderStore,
    agentStore,
    personalizationStore: new PostgresPersonalizationStore(db),
    personaStore: new PostgresPersonaStore(db),
    spaceStore: new PostgresSpaceStore(db),
    repositoryStore: new PostgresRepositoryStore(db),
    scheduleStore: new PostgresScheduleStore(db),
    sessionMetricsStore: new PostgresSessionMetricsStore(db),
    turnArtifactStore: new PostgresTurnArtifactStore(db),
    chatImages: createChatImageService({
      store: new PostgresChatImageStore(db),
      sessionStore,
      turnArtifactStore: new PostgresTurnArtifactStore(db),
      reencode: createImageReencoder({ resolveSandbox: () => null }),
      sentinel: sentinelServices,
      fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
    }),
    globalSettingsStore: new PostgresGlobalSettingsStore(db),
    sessionStore,
    sentinelAuditStore,
    sentinelSettingsStore,
    sessions: new Sessions({ sessionStore, sentinelServices }),
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
  });
  return wrap({ app, backends, close: database.teardown });
}

export async function startOwnershipServer(engine: OwnershipEngine): Promise<OwnershipServer | undefined> {
  return engine === 'sqlite' ? await startSqlite() : await startPostgres();
}
