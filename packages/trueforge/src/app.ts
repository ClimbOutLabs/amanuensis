/** The API: resource routers, the OpenAPI document and Swagger UI, all under /api/v1. */
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { ISessionStore, Sessions, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { RedisClientType } from 'redis';
import type { Logger } from 'winston';
import { createAgentImportRouter } from './apis/agentImport';
import { createAgentsRouter } from './apis/agents';
import { createAuthRouter } from './apis/auth';
import { createBugReportRouter } from './apis/bugReport';
import { createAppBugReportRouter } from './apis/bugReportApp';
import { createCapabilitiesRouter } from './apis/capabilities';
import { createCatalogRouter } from './apis/catalog';
import { createMapsRouter } from './apis/maps';
import { createMcpOAuthRouter } from './apis/mcpOAuth';
import { createMcpServersRouter } from './apis/mcpServers';
import { createMemoryVaultRouter } from './apis/memoryVault';
import { createModelsRouter } from './apis/models';
import { createPermissionsRouter } from './apis/permissions';
import { createPersonaKnowledgeRouter } from './apis/personaKnowledge';
import { createPersonalizationRouter } from './apis/personalization';
import { createPersonasRouter, createSessionPersonasRouter } from './apis/personas';
import { createRepositoriesRouter, createSessionRepositoryRouter } from './apis/repositories';
import { createScheduleExecutionRouter, createSchedulesRouter } from './apis/schedules';
import { createSentinelSettingsRouter } from './apis/sentinelSettings';
import { createSessionFolderAssignmentsRouter, createSessionFoldersRouter } from './apis/sessionFolders';
import { createInternalMetricsRouter } from './apis/sessionMetrics';
import { createInternalSessionsRouter, createSessionsRouter } from './apis/sessions';
import { createSettingsRouter } from './apis/settings';
import { createAvailableSkillsRouter, type ResolveSkillStore } from './apis/skills';
import { createSpacesRouter } from './apis/spaces';
import { createTurnsRouter } from './apis/turns';
import { createVoiceRouter } from './apis/voice';
import type { Authenticator } from './auth/authenticator';
import type { Authorizer } from './auth/authorizer';
import { resolveRequestContext } from './auth/identity';
import {
  createAdminAuthMiddleware,
  createApiKeyAuthMiddleware,
  createAuthMiddleware,
  createUiSessionAuthMiddleware,
  truefoundryAdminMiddleware,
} from './auth/middleware';
import type { OidcDiscoveryHandle } from './auth/oidc';
import { createRequestGuardMiddleware } from './auth/requestGuard';
import type { McpCatalog } from './catalog/McpCatalog';
import type { ModelCatalog } from './catalog/ModelCatalog';
import type { SandboxCatalog } from './catalog/SandboxCatalog';
import type { SkillCatalog } from './catalog/SkillCatalog';
import configuration, {
  getPublicBaseUrl,
  getPublicUiBasePath,
  getTrueForgeAuthMode,
  isTrueFoundryModeEnabled,
  TrueForgeAuthMode,
} from './config';
import type { AgentRecord, IAgentStore } from './db/agentStore';
import type { ICompletedTurnEventStore } from './db/completedTurnEvents';
import type { IGlobalSettingsStore } from './db/globalSettingsStore';
import type { IMcpServerWithAuthStore } from './db/mcpServerStore';
import type { IMcpToolGrantStore } from './db/mcpToolGrantStore';
import type { IModelProviderStore } from './db/modelProviderStore';
import type { IPersonalizationStore } from './db/personalizationStore';
import type { IPersonaStore } from './db/personaStore';
import type { IRepositoryStore } from './db/repositoryStore';
import type { ISandboxProviderStore } from './db/sandboxProviderStore';
import type { IScheduleStore } from './db/scheduleStore';
import type { ISentinelAuditStore } from './db/sentinelAuditStore';
import type { ISentinelSettingsStore } from './db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from './db/sessionCustom';
import type { ISessionMetricsStore } from './db/sessionMetricsStore';
import type { ISkillStore } from './db/skillStore';
import type { ISpaceStore } from './db/spaceStore';
import type { WithTransaction } from './db/transaction';
import type { ITurnArtifactStore } from './db/turnArtifactStore';
import { createClientCertificateMiddleware } from './http/tls';
import type { IOAuthTokenStore } from './mcp/auth/types';
import { PACKAGE_VERSION } from './packageVersion';
import { OPENAPI_DOCUMENT_TAGS } from './routes/openapiTags';
import type { ActiveTurnRegistry } from './runtime/activeTurns';
import type { EventSubscriptionRegistry } from './runtime/event-subscription';
import type { resolveSandboxProvider } from './runtime/sessionResources';
import { TokenFactoryDailyCapError, type TokenFactoryBudget } from './runtime/tokenFactoryBudget';
import { envManagedModelProviderNames } from './runtime/tokenFactoryProvider';
import type { TurnDrainRegistry } from './runtime/turnDrains';
import { InvalidCronError } from './schemas/schedule';
import { zodErrorResponse, zodValidationHook } from './zodErrorResponse';

const BEARER_AUTH_SCHEME = 'BearerAuth';

function withAuth(router: OpenAPIHono, middleware: MiddlewareHandler): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', middleware);
  shell.route('/', router);
  return shell;
}

function withAdminAuth(router: OpenAPIHono, middleware: MiddlewareHandler): OpenAPIHono {
  const shell = new OpenAPIHono();
  shell.use('*', middleware);
  shell.route('/', router);
  return shell;
}

/** One line per request: method, path, status, duration. Skips `/healthz`. */
export function createAccessLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === '/healthz') {
      return;
    }
    logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(performance.now() - started),
    });
  };
}

/** Hono bodyLimit wrapper that returns the API error envelope on 413. */
export function createRequestBodyLimitMiddleware(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: c =>
      c.json({ error: { message: `Request body exceeds the maximum size of ${String(maxSize)} bytes` } }, 413),
  });
}

export function createAppErrorHandler(params: { logger: Logger }): ErrorHandler {
  return (error, c) => {
    if (error instanceof z.ZodError) {
      return zodErrorResponse(c, error);
    }
    if (error instanceof InvalidCronError) {
      return c.json({ error: { message: error.message } }, 400);
    }
    if (error instanceof TokenFactoryDailyCapError) {
      return c.json({ error: { message: error.message, type: 'rate_limit', code: error.code } }, 429);
    }
    if (error instanceof HTTPException) {
      if (error.status >= 500) {
        params.logger.error('Server API error', {
          status: error.status,
          ...extractErrorLogFields(error),
        });
      }
      return c.json({ error: { message: error.message } }, error.status);
    }
    params.logger.error('Unhandled error', extractErrorLogFields(error));
    return c.json({ error: { message: 'Internal server error' } }, 500);
  };
}

const openApiDocConfig = {
  openapi: '3.1.0',
  info: {
    title: 'TrueForge API',
    description:
      'HTTP API for the TrueForge agent server (`/api/v1`). Interactive docs are served at `/api/v1/docs` ' +
      '(OpenAPI JSON at `/api/v1/openapi.json`).\n\n' +
      '**Authentication:** Standalone auth accepts requests without credentials — middleware ' +
      'stamps a local default user. When OIDC or TrueFoundry auth is configured, protected routes require a valid ' +
      'cookie or `Authorization: Bearer` token. There is no built-in API-key scheme; ' +
      'pass custom headers only if your reverse proxy or IdP layer requires them.\n\n' +
      'Covers DB-backed sessions, the agent registry, settings catalogs, and model/MCP/skill/sandbox providers.',
    version: PACKAGE_VERSION,
  },
  tags: OPENAPI_DOCUMENT_TAGS,
};

/** Registers the Bearer ID-token scheme used by {@link buildOpenApiDocument}. */
export function registerOpenApiBearerAuth(app: OpenAPIHono): void {
  app.openAPIRegistry.registerComponent('securitySchemes', BEARER_AUTH_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Caller credential (`Authorization: Bearer <token>`). Required on protected routes when auth is enabled. ' +
      'Browser sessions may use the HttpOnly `id_token` or `accessToken` cookie instead.',
  });
}

/**
 * Single source for both the served document and the one the SDK is built from.
 * When `authEnabled`, advertises required Bearer auth on operations that inherit global security.
 * `serverUrl` is the public prefix for Try it out (e.g. `/custom/proxy/path`); omit for the SDK spec.
 */
export function buildOpenApiDocument(app: OpenAPIHono, options?: { authEnabled?: boolean; serverUrl?: string }) {
  const authEnabled = options?.authEnabled ?? false;
  if (authEnabled) {
    registerOpenApiBearerAuth(app);
  }
  const serverUrl = options?.serverUrl;
  return app.getOpenAPI31Document({
    ...openApiDocConfig,
    ...(authEnabled ? { security: [{ [BEARER_AUTH_SCHEME]: [] }] } : {}),
    ...(serverUrl !== undefined && serverUrl !== '' ? { servers: [{ url: serverUrl }] } : {}),
  });
}

function routeNotFound(c: Context) {
  return c.json({ error: { message: `Route not found: ${c.req.method} ${c.req.path}` } }, 404);
}

export interface ServerDeps<TTransaction> {
  modelCatalog: ModelCatalog;
  mcpCatalog: McpCatalog;
  skillCatalog: SkillCatalog;
  sandboxCatalog: SandboxCatalog;
  /** Per-request store: DB singleton, or a token-bound TrueFoundry store in TrueFoundry mode. */
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  /**
   * Per-request store: DB singleton, or a token-bound TrueFoundry store in TrueFoundry mode.
   * The unauthenticated OAuth callback has no context and gets the DB persistence store.
   */
  resolveMcpServerStore: (c?: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore<TTransaction>;
  /** Per-request store: DB singleton, or a token-bound TrueFoundry decorator in TrueFoundry mode. */
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  /** Import agents: store with SF client constructor assume-user headers (DB store when TrueFoundry mode is off). */
  resolveImportAgentStore: (serviceFoundryServerHeaders: Record<string, string>) => IAgentStore<TTransaction>;
  /**
   * Per-request store: DB singleton, or the env-backed shared store in TrueFoundry mode
   * (`TRUEFOUNDRY_SANDBOX_*` + static SETTINGS JSON).
   */
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  /** Per-request store: DB git skills, or TrueFoundry registry catalog in TrueFoundry mode. */
  resolveSkillStore: ResolveSkillStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  /** Per-user Always allow grants; the same store backs Sentinel classification. */
  mcpToolGrantStore: IMcpToolGrantStore<TTransaction>;
  skillStore: ISkillStore<TTransaction>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  /** Optional host override; the standard resolver remains the production default. */
  sandboxProviderResolver?: typeof resolveSandboxProvider | undefined;
  agentStore: IAgentStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  repositoryStore: IRepositoryStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  sessionMetricsStore: ISessionMetricsStore;
  sentinelAuditStore: ISentinelAuditStore;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  /** Not tenant-scoped: the persisted live tool-output screen override is global. */
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Per-instance daily Token Factory token cap, enforced when a turn starts on Token Factory. */
  tokenFactoryBudget: TokenFactoryBudget;
  /** Post-completion passthrough appends ride the same store (see db/completedTurnEvents.ts). */
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  sessions: Sessions<SessionCustom, TurnCustom>;
  activeTurns: ActiveTurnRegistry;
  /** Tracks in-flight turn event drains so shutdown can wait for them. */
  turnDrains: TurnDrainRegistry;
  /** Primary Redis client (server-owned); undefined in standalone mode. */
  redis?: RedisClientType | undefined;
  /** Request-reply dispatch table served by this replica's executor. */
  requestReplyRouter: RequestReplyRouter;
  /** Hands out each turn's resumable event stream to the create and subscribe handlers. */
  eventSubscriptions: EventSubscriptionRegistry<TurnStreamingEvent>;
  logger: Logger;
  /** Background OIDC discovery; undefined when browser login is disabled. */
  oidcDiscovery: OidcDiscoveryHandle | undefined;
  /** Startup-selected authenticator; middleware is built from this once per app. */
  authenticator: Authenticator;
  /** Startup-selected agent authorization policy. */
  authorizer: Authorizer;
}

export function createServerApp<TTransaction>(deps: ServerDeps<TTransaction>) {
  const app = new OpenAPIHono({ defaultHook: zodValidationHook });
  const authMiddleware = createAuthMiddleware(deps.authenticator);
  const adminAuthMiddleware = createAdminAuthMiddleware(deps.authenticator);
  const scheduleExecutionAuthMiddleware = createApiKeyAuthMiddleware(configuration.TRUEFORGE_API_KEY);
  const authEnabled = getTrueForgeAuthMode() !== TrueForgeAuthMode.Standalone;
  const envManagedProviders = envManagedModelProviderNames({
    apiKey: configuration.NEBIUS_API_KEY,
    managedByTrueFoundry: isTrueFoundryModeEnabled(),
  });
  const scheduleTurnDeps = {
    scheduleStore: deps.scheduleStore,
    sessions: deps.sessions,
    agentStore: deps.agentStore,
    eventSubscriptions: deps.eventSubscriptions,
    logger: deps.logger,
    resolveModelProviderStore: deps.resolveModelProviderStore,
    resolveMcpServerStore: deps.resolveMcpServerStore,
    resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
    activeTurns: deps.activeTurns,
    turnDrains: deps.turnDrains,
    resolveSkillStore: deps.resolveSkillStore,
    tokenStore: deps.tokenStore,
    repositoryStore: deps.repositoryStore,
    sessionStore: deps.sessionStore,
    spaceStore: deps.spaceStore,
    turnArtifactStore: deps.turnArtifactStore,
    sandboxProviderResolver: deps.sandboxProviderResolver,
    globalSettingsStore: deps.globalSettingsStore,
    tokenFactoryBudget: deps.tokenFactoryBudget,
  };

  if (configuration.ACCESS_LOGS) {
    app.use('*', createAccessLogMiddleware(deps.logger));
  }
  if (!configuration.STANDALONE && configuration.TRUEFORGE_MTLS_ENABLED) {
    app.use('*', createClientCertificateMiddleware(deps.logger));
  }
  // Standalone sessions are cookies, so reject foreign Hosts and cross-origin writes before any router.
  if (configuration.STANDALONE && authEnabled) {
    app.use('*', createRequestGuardMiddleware({ port: configuration.PORT, publicBaseUrl: getPublicBaseUrl() }));
  }
  app.use('*', createRequestBodyLimitMiddleware(configuration.MAX_REQUEST_BODY_BYTES));

  app.get('/healthz', c => c.json({ status: 'ok', version: PACKAGE_VERSION }));

  app.route(
    '/api/v1/auth',
    createAuthRouter({
      oidcDiscovery: deps.oidcDiscovery,
      logger: deps.logger,
      authMiddleware,
    }),
  );
  app.route(
    '/api/v1/capabilities',
    withAuth(
      createCapabilitiesRouter({
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        mcpServerStore: deps.resolveMcpServerStore(),
        globalSettingsStore: deps.globalSettingsStore,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/models',
    withAuth(
      createModelsRouter({
        resolveModelProviderStore: deps.resolveModelProviderStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
        globalSettingsStore: deps.globalSettingsStore,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/catalogs',
    withAuth(
      createCatalogRouter({
        modelCatalog: deps.modelCatalog,
        mcpCatalog: deps.mcpCatalog,
        skillCatalog: deps.skillCatalog,
        sandboxCatalog: deps.sandboxCatalog,
      }),
      authMiddleware,
    ),
  );
  // Public MCP OAuth callbacks (local DCR + TrueFoundry/SFY) must be registered before the gated
  // `/mcp-servers` mount so `withAuth` cannot intercept IdP redirects to `/api/v1/mcp-servers/oauth/*`.
  app.route(
    '/api/v1/mcp-servers/oauth',
    createMcpOAuthRouter({
      tokenStore: deps.tokenStore,
      mcpServerStore: deps.resolveMcpServerStore(),
      logger: deps.logger,
    }),
  );
  app.route(
    '/api/v1/mcp-servers',
    withAuth(
      createMcpServersRouter({
        resolveMcpServerStore: deps.resolveMcpServerStore,
        tokenStore: deps.tokenStore,
        toolGrantStore: deps.mcpToolGrantStore,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/skills',
    withAuth(
      createAvailableSkillsRouter({
        resolveSkillStore: deps.resolveSkillStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/agents',
    withAuth(
      createAgentsRouter({
        resolveAgentStore: deps.resolveAgentStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/internal/schedules',
    withAuth(createScheduleExecutionRouter(scheduleTurnDeps), scheduleExecutionAuthMiddleware),
  );
  app.route(
    '/api/v1/schedules',
    withAuth(
      createSchedulesRouter({
        ...scheduleTurnDeps,
        resolveAgentStore: deps.resolveAgentStore,
        withTransaction: deps.withTransaction,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/memory/vault',
    withAuth(
      createMemoryVaultRouter({
        resolveRequestContext,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/settings',
    withAdminAuth(
      createSettingsRouter({
        mcpCatalog: deps.mcpCatalog,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        tokenStore: deps.tokenStore,
        toolGrantStore: deps.mcpToolGrantStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        globalSettingsStore: deps.globalSettingsStore,
        tokenFactoryBudget: deps.tokenFactoryBudget,
        envManagedModelProviderNames: envManagedProviders,
        withTransaction: deps.withTransaction,
        logger: deps.logger,
        resolveRequestContext,
      }),
      adminAuthMiddleware,
    ),
  );
  app.route(
    '/api/internal/import',
    withAuth(
      createAgentImportRouter({
        sessionStore: deps.sessionStore,
        resolveImportAgentStore: deps.resolveImportAgentStore,
      }),
      truefoundryAdminMiddleware,
    ),
  );
  app.route(
    '/api/internal/sessions',
    withAuth(
      createInternalSessionsRouter({
        sessions: deps.sessions,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/internal/metrics',
    withAuth(
      createInternalMetricsRouter({
        sessionMetricsStore: deps.sessionMetricsStore,
        resolveRequestContext,
        resolveAgentStore: deps.resolveAgentStore,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/internal',
    withAuth(
      createPermissionsRouter({
        authorizer: deps.authorizer,
        resolveAgentStore: deps.resolveAgentStore,
        scheduleStore: deps.scheduleStore,
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/personalization',
    withAuth(
      createPersonalizationRouter({
        personalizationStore: deps.personalizationStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/user/settings/sentinel',
    withAuth(
      createSentinelSettingsRouter({
        sentinelSettingsStore: deps.sentinelSettingsStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  // Same-origin tile proxy for embedded maps. Browser session only: bearer
  // credentials (agents, sandboxes, API clients) are refused.
  app.route(
    '/api/maps',
    withAuth(
      createMapsRouter({
        sentinelSettingsStore: deps.sentinelSettingsStore,
        resolveRequestContext,
        logger: deps.logger,
      }),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  app.route(
    '/api/v1/personas',
    withAuth(
      createPersonasRouter({
        personaStore: deps.personaStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveRequestContext,
        knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/personas',
    withAuth(
      createPersonaKnowledgeRouter({
        personaStore: deps.personaStore,
        resolveRequestContext,
        knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
        modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/spaces',
    withAuth(
      createSpacesRouter({
        spaceStore: deps.spaceStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/repositories',
    withAuth(
      createRepositoriesRouter({
        repositoryStore: deps.repositoryStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/session-folders',
    withAuth(
      createSessionFoldersRouter({
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createSessionsRouter({
        sessions: deps.sessions,
        sessionStore: deps.sessionStore,
        sentinelAuditStore: deps.sentinelAuditStore,
        activeTurns: deps.activeTurns,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        redis: deps.redis,
        requestReplyRouter: deps.requestReplyRouter,
        resolveRequestContext,
        logger: deps.logger,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createBugReportRouter({
        sessions: deps.sessions,
        agentStore: deps.agentStore,
        sandboxProviderStore: deps.sandboxProviderStore,
        mcpServerStore: deps.resolveMcpServerStore(),
        globalSettingsStore: deps.globalSettingsStore,
        resolveRequestContext,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/bug-reports',
    withAuth(
      createAppBugReportRouter({
        sandboxProviderStore: deps.sandboxProviderStore,
        mcpServerStore: deps.resolveMcpServerStore(),
        globalSettingsStore: deps.globalSettingsStore,
        resolveRequestContext,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/voice',
    withAuth(
      createVoiceRouter({
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createSessionFolderAssignmentsRouter({
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createSessionPersonasRouter({
        personaStore: deps.personaStore,
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createSessionRepositoryRouter({
        repositoryStore: deps.repositoryStore,
        sessionStore: deps.sessionStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createTurnsRouter({
        sessions: deps.sessions,
        sessionStore: deps.sessionStore,
        activeTurns: deps.activeTurns,
        turnDrains: deps.turnDrains,
        tokenStore: deps.tokenStore,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSkillStore: deps.resolveSkillStore,
        resolveAgentStore: deps.resolveAgentStore,
        personalizationStore: deps.personalizationStore,
        personaStore: deps.personaStore,
        spaceStore: deps.spaceStore,
        repositoryStore: deps.repositoryStore,
        turnArtifactStore: deps.turnArtifactStore,
        globalSettingsStore: deps.globalSettingsStore,
        tokenFactoryBudget: deps.tokenFactoryBudget,
        eventSubscriptions: deps.eventSubscriptions,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        sandboxProviderResolver: deps.sandboxProviderResolver,
        logger: deps.logger,
        resolveRequestContext,
        authorizer: deps.authorizer,
      }),
      authMiddleware,
    ),
  );

  const uiBasePath = getPublicUiBasePath();
  const openApiSpecPath = `${uiBasePath}api/v1/openapi.json`;
  const openApiServerUrl = uiBasePath === '/' ? undefined : uiBasePath.replace(/\/$/, '');
  app.get('/api/v1/docs', swaggerUI({ url: openApiSpecPath }));
  app.get('/api/v1/openapi.json', c =>
    c.json(
      buildOpenApiDocument(app, {
        authEnabled,
        ...(openApiServerUrl === undefined ? {} : { serverUrl: openApiServerUrl }),
      }),
    ),
  );

  app.notFound(routeNotFound);

  app.onError(createAppErrorHandler({ logger: deps.logger }));

  return app;
}
