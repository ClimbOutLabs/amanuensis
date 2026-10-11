/**
 * Boots the real server app (`createServerApp`) over a temp-file SQLite database, an
 * inert MCP connector and a scripted OpenAI-compatible endpoint, so approval tests
 * drive `/api/v1/...` rather than harness internals.
 *
 * The database lives in a temp directory rather than `:memory:` so `restart()` can
 * drop every in-process registry and reopen the same durable state.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { Sessions, type TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  type SandboxProvider,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import { TENANT_ID } from '../../src/apis/sessions';
import { createServerApp } from '../../src/app';
import { TrueForgeAuthorizer } from '../../src/auth/authorizer';
import { createAuthenticator } from '../../src/auth/createAuthenticator';
import { McpCatalog } from '../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../src/catalog/SkillCatalog';
import { TrueForgeAuthMode } from '../../src/config';
import { McpServerWithAuthStore } from '../../src/db/McpServerWithAuthStore';
import type { IMcpServerStore } from '../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../src/db/sentinelAuditStore';
import { SqliteAgentStore } from '../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteRepositoryStore } from '../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionMetricsStore } from '../../src/db/sqlite/session-metrics/SqliteSessionMetricsStore';
import { SqliteSessionStore } from '../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { ActiveTurnRegistry } from '../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../src/runtime/event-subscription';
import { TurnDrainRegistry } from '../../src/runtime/turnDrains';
import { INERT_SERVER_NAME, startInertMcpServer, type InertMcpServer } from './inertMcpServer';
import { startScriptedModelServer, type ScriptedModelServer } from './scriptedModelServer';

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
  close: () => Promise<void>;
}

function buildApp(db: SqliteDb, sandboxProvider: SandboxProvider | undefined): OpenAPIHono {
  const sessionStore = new SqliteSessionStore(db);
  const sentinelAuditStore = new SentinelAuditStore(db);
  const sentinelServices: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    audit: sentinelAuditStore,
  };
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
  return createServerApp({
    modelCatalog: ModelCatalog.load(),
    mcpCatalog: McpCatalog.load(),
    skillCatalog: SkillCatalog.load(),
    sandboxCatalog: SandboxCatalog.load(),
    withTransaction: callback => db.transaction().execute(callback),
    tokenStore,
    skillStore,
    sandboxProviderStore,
    sandboxProviderResolver: sandboxProvider === undefined ? undefined : () => Promise.resolve(sandboxProvider),
    agentStore,
    personalizationStore: new SqlitePersonalizationStore(db),
    personaStore: new SqlitePersonaStore(db),
    spaceStore: new SqliteSpaceStore(db),
    repositoryStore: new SqliteRepositoryStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    sessionMetricsStore: new SqliteSessionMetricsStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    globalSettingsStore,
    sessionStore,
    sentinelAuditStore,
    sessions: new Sessions({ sessionStore, sentinelServices }),
    activeTurns: new ActiveTurnRegistry(),
    turnDrains: new TurnDrainRegistry(),
    requestReplyRouter: new RequestReplyRouter(),
    eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
    logger: createLogger({ silent: true }),
    oidcDiscovery: undefined,
    authenticator: createAuthenticator({ mode: TrueForgeAuthMode.Standalone }),
    authorizer: new TrueForgeAuthorizer(),
    resolveModelProviderStore: () => modelProviderStore,
    resolveMcpServerStore: () => mcpServerStore,
    resolveAgentStore: () => agentStore,
    resolveImportAgentStore: () => agentStore,
    resolveSandboxProviderStore: () => sandboxProviderStore,
    resolveSkillStore: () => skillStore,
  });
}

export async function startApprovalTestServer(options?: {
  sandboxProvider?: SandboxProvider | undefined;
}): Promise<ApprovalTestServer> {
  const mcp = await startInertMcpServer();
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
          properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['none'] },
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
  });

  let app = buildApp(db, options?.sandboxProvider);

  return {
    // Hono's request() is sync-or-async depending on the route; the fixture
    // contract is uniformly async, so normalise here rather than at every call.
    request: async (path, init) => await app.request(path, init),
    restart: async () => {
      await db.destroy();
      db = createSqliteDb(databaseFile);
      app = buildApp(db, options?.sandboxProvider);
    },
    mcp,
    model,
    mcpServerStore: () => new SqliteMcpServerStore(db),
    close: async () => {
      await db.destroy();
      await model.close();
      await mcp.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
