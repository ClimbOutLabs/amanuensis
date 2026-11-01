/** The API: resource routers, the OpenAPI document and Swagger UI, all under /api/v1. */
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { ISessionStore, Sessions, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  existingSandboxIdForProvider,
  extractErrorLogFields,
  rawSandboxId,
  repositoryRootsMatch,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { RequestReplyRouter } from '@truefoundry/trueforge-core/request-reply';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { RedisClientType } from 'redis';
import type { Logger } from 'winston';
import { createAgentImportRouter } from './apis/agentImport';
import { createAgentsRouter } from './apis/agents';
import { createAuditLogRouter } from './apis/auditLog';
import { createAuthRouter } from './apis/auth';
import { createBriefItemsRouter } from './apis/briefItems';
import { createBugReportRouter } from './apis/bugReport';
import { createAppBugReportRouter } from './apis/bugReportApp';
import { CALENDAR_SETTINGS_BASE_PATH, createCalendarAccountRouter } from './apis/calendarAccount';
import { createCapabilitiesRouter } from './apis/capabilities';
import { createCatalogRouter } from './apis/catalog';
import { createChatImagesRouter } from './apis/chatImages';
import { createChatPicturesRouter } from './apis/chatPictures';
import { createDataExportRouter } from './apis/dataExport';
import { createDataImportRouter } from './apis/dataImport';
import { createEmailAccountRouter, EMAIL_SETTINGS_BASE_PATH } from './apis/emailAccount';
import { createGoogleRouter } from './apis/google';
import { createHelpRouter } from './apis/help';
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
import { createInternalSessionsRouter, createSessionsRouter, sandboxIdOfLastTurn } from './apis/sessions';
import { createSettingsRouter } from './apis/settings';
import { createAvailableSkillsRouter, type ResolveSkillStore } from './apis/skills';
import { createSpaceFolderAssignmentsRouter, createSpaceFoldersRouter } from './apis/spaceFolders';
import { createSpacePicturesRouter } from './apis/spacePictures';
import { createSpacesRouter } from './apis/spaces';
import { createTurnsRouter } from './apis/turns';
import { createVoiceRouter } from './apis/voice';
import type { Authenticator } from './auth/authenticator';
import type { Authorizer } from './auth/authorizer';
import { resolveRequestContext, STANDALONE_REQUEST_CONTEXT } from './auth/identity';
import { listedOriginMiddleware } from './auth/listedOriginContext';
import { createLoginProxy, isProxiableIssuer } from './auth/loginProxy';
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
  getAllowedOrigins,
  getPublicBaseUrl,
  getPublicUiBasePath,
  getTrueForgeAuthMode,
  isTrueFoundryModeEnabled,
  TrueForgeAuthMode,
} from './config';
import type { AgentRecord, IAgentStore } from './db/agentStore';
import type { IBriefItemCompletionStore } from './db/briefItemCompletionStore';
import type { ICompletedTurnEventStore } from './db/completedTurnEvents';
import type { IGlobalSettingsStore } from './db/globalSettingsStore';
import type { IGoogleConnectionStore } from './db/googleConnectionStore';
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
import type { SchedulerProbe } from './help/healthCheck';
import { mountCatalogLogos } from './http/catalogLogos';
import { createClientCertificateMiddleware } from './http/tls';
import type { IOAuthTokenStore } from './mcp/auth/types';
import { PACKAGE_VERSION } from './packageVersion';
import { getPersonaKnowledgeIndexer } from './personaKnowledge/knowledgeIndexer';
import { ensureAmanGuide } from './personas/amanGuide/install';
import { createGuideSeeder, seedExistingGuides } from './personas/amanGuide/seed';
import { GOOGLE_ROUTES_BASE_PATH } from './routes/googleRoutes';
import { OPENAPI_DOCUMENT_TAGS } from './routes/openapiTags';
import type { ActiveTurnRegistry } from './runtime/activeTurns';
import type { ChatImageService } from './runtime/chatImages/chatImageService';
import { createChatPictureService } from './runtime/chatPictures/chatPictureService';
import { resolveDefaultChatModel } from './runtime/defaultChatModel';
import type { EventSubscriptionRegistry } from './runtime/event-subscription';
import { resolveSandboxProvider } from './runtime/sessionResources';
import { createSpacePictureService } from './runtime/spacePictures/spacePictureService';
import { TokenFactoryDailyCapError, type TokenFactoryBudget } from './runtime/tokenFactoryBudget';
import { envManagedModelProviderNames } from './runtime/tokenFactoryProvider';
import type { TurnDrainRegistry } from './runtime/turnDrains';
import { InvalidCronError } from './schemas/schedule';
import { TENANT_ID } from './tenancy';
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

/**
 * One line per request: method, path, status, duration. Skips `/healthz`.
 * Successful read-only requests log at debug; mutations and errors stay at info.
 */
export function createAccessLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === '/healthz') {
      return;
    }
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(performance.now() - started),
    };
    if (c.req.method === 'GET' && c.res.status < 400) {
      logger.debug('request', fields);
    } else {
      logger.info('request', fields);
    }
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
  /** Per-user Google logins and the consent each user has in flight. */
  googleConnectionStore: IGoogleConnectionStore;
  skillStore: ISkillStore<TTransaction>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  /** Optional host override; the standard resolver remains the production default. */
  sandboxProviderResolver?: typeof resolveSandboxProvider | undefined;
  agentStore: IAgentStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  personaStore: IPersonaStore<TTransaction>;
  /** The shared store, used at boot when there is no request to resolve a per-person store from. */
  modelProviderStore: IModelProviderStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  repositoryStore: IRepositoryStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  sessionMetricsStore: ISessionMetricsStore;
  sentinelAuditStore: ISentinelAuditStore;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  briefItemStore: IBriefItemCompletionStore;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  /** Not tenant-scoped: the persisted live tool-output screen override is global. */
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Whether the in-process schedule loop is running; the help check reads it. */
  schedulerStatus: () => SchedulerProbe;
  /** Per-instance daily Token Factory token cap, enforced when a turn starts on Token Factory. */
  tokenFactoryBudget: TokenFactoryBudget;
  /** Post-completion passthrough appends ride the same store (see db/completedTurnEvents.ts). */
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  sessions: Sessions<SessionCustom, TurnCustom>;
  /** Re-encoded images shown in chat. */
  chatImages: ChatImageService;
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
  /** Exact secret values this server holds; Sentinel's outbound guard and the data export both read them. */
  outboundSecrets: SentinelServices['outboundSecrets'];
}

/**
 * Whether the sandbox the chat last used already holds a real checkout at the
 * workspace path. Git must name the path as the checkout root and HEAD must
 * resolve to a commit, so an empty folder, a repo with no commits yet, and the
 * leftover of an interrupted clone do not count. The recorded sandbox id goes
 * through the same provider gate turn admit uses, and any failure to tell
 * counts as no checkout, so start work refuses plainly instead of failing.
 */
export async function resolveCheckoutExistsInSessionSandbox(input: {
  deps: {
    sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession' | 'getTurn'>;
    logger: Logger;
    sandboxProviderResolver: typeof resolveSandboxProvider | undefined;
    resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore;
  };
  c: Context;
  session_id: string;
  workspace_cwd: string;
}): Promise<boolean> {
  const { deps, c, session_id, workspace_cwd } = input;
  try {
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id });
    if (session === undefined) {
      return false;
    }
    const recordedSandboxId = await sandboxIdOfLastTurn({
      deps: { sessionStore: deps.sessionStore, logger: deps.logger },
      record: session,
    });
    if (recordedSandboxId === undefined) {
      return false;
    }
    const resolver = deps.sandboxProviderResolver ?? resolveSandboxProvider;
    const provider = await resolver({
      tenant_id: TENANT_ID,
      store: deps.resolveSandboxProviderStore(c),
      logger: deps.logger,
      sessionId: session_id,
    });
    if (provider === undefined) {
      return false;
    }
    const sandboxId = existingSandboxIdForProvider({
      existingSandboxId: recordedSandboxId,
      currentProviderType: provider.type,
    });
    if (sandboxId === undefined) {
      return false;
    }
    const root = await provider.exec({
      sandboxId: rawSandboxId(sandboxId),
      command: 'git rev-parse --show-toplevel',
      cwd: workspace_cwd,
    });
    if (
      !root.success ||
      root.response.exitCode !== 0 ||
      !repositoryRootsMatch({ expected: workspace_cwd, actual: root.response.result.trim() })
    ) {
      return false;
    }
    const head = await provider.exec({
      sandboxId: rawSandboxId(sandboxId),
      command: 'git rev-parse HEAD',
      cwd: workspace_cwd,
    });
    return head.success && head.response.exitCode === 0 && head.response.result.trim().length > 0;
  } catch (error) {
    deps.logger.warn('Could not check for a checkout before starting work', extractErrorLogFields(error));
    return false;
  }
}

export function createServerApp<TTransaction>(deps: ServerDeps<TTransaction>) {
  const app = new OpenAPIHono({ defaultHook: zodValidationHook });
  // Installs the Aman guide for a person and refreshes it on upgrade. It waits for a default model,
  // since the guide answers with one.
  const ensureAmanGuideFor = async ({
    userId,
    modelProviderStore,
  }: {
    userId: string;
    modelProviderStore: IModelProviderStore;
  }): Promise<void> => {
    const modelName = await resolveDefaultChatModel({
      tenantId: TENANT_ID,
      modelProviderStore,
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    if (modelName === undefined) {
      return;
    }
    const indexer = getPersonaKnowledgeIndexer({
      knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
      modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
      logger: deps.logger,
    });
    await ensureAmanGuide({
      personaStore: deps.personaStore,
      tenantId: TENANT_ID,
      userId,
      modelName,
      knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
      enqueue: input => {
        indexer.enqueue(input);
      },
      logger: deps.logger,
    });
  };
  // One Iris per person: she is installed when a person first signs in to this process (a new account, or an
  // existing one after a restart), and the standalone person at boot. Each request waits for her, so Settings
  // lists her on the first load. The install never rejects, so a broken install cannot block a request.
  const seedGuide = createGuideSeeder({ logger: deps.logger });
  const authenticate = createAuthMiddleware(deps.authenticator);
  const authMiddleware: MiddlewareHandler = async (c, next) => {
    await authenticate(c, async () => {
      const requestContext = c.get('request_context');
      if (requestContext !== undefined) {
        const userId = requestContext.subject.id;
        await seedGuide(userId, () =>
          ensureAmanGuideFor({ userId, modelProviderStore: deps.resolveModelProviderStore(c) }),
        );
      }
      await next();
    });
  };
  // Boot refreshes every person who already has Iris, then the standalone person, who may have none yet.
  const bootGuides = seedExistingGuides({
    listOwners: () => deps.personaStore.listPersonaOwners({ tenant_id: TENANT_ID }),
    seed: userId =>
      seedGuide(userId, () => ensureAmanGuideFor({ userId, modelProviderStore: deps.modelProviderStore })),
    logger: deps.logger,
  });
  if (configuration.STANDALONE) {
    void seedGuide(STANDALONE_REQUEST_CONTEXT.subject.id, () =>
      ensureAmanGuideFor({
        userId: STANDALONE_REQUEST_CONTEXT.subject.id,
        modelProviderStore: deps.modelProviderStore,
      }),
    );
  }
  const adminAuthMiddleware = createAdminAuthMiddleware(deps.authenticator);
  const scheduleExecutionAuthMiddleware = createApiKeyAuthMiddleware(configuration.TRUEFORGE_API_KEY);
  const authEnabled = getTrueForgeAuthMode() !== TrueForgeAuthMode.Standalone;
  const envManagedProviders = envManagedModelProviderNames({
    apiKey: configuration.NEBIUS_API_KEY,
    managedByTrueFoundry: isTrueFoundryModeEnabled(),
  });
  const scheduleTurnDeps = {
    mcpCatalog: deps.mcpCatalog,
    scheduleStore: deps.scheduleStore,
    briefItemStore: deps.briefItemStore,
    sessions: deps.sessions,
    agentStore: deps.agentStore,
    personaStore: deps.personaStore,
    personalizationStore: deps.personalizationStore,
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
    googleConnectionStore: deps.googleConnectionStore,
    turnArtifactStore: deps.turnArtifactStore,
    sandboxProviderResolver: deps.sandboxProviderResolver,
    globalSettingsStore: deps.globalSettingsStore,
    tokenFactoryBudget: deps.tokenFactoryBudget,
    audit: deps.sentinelAuditStore,
  };

  if (configuration.ACCESS_LOGS) {
    app.use('*', createAccessLogMiddleware(deps.logger));
  }
  if (!configuration.STANDALONE && configuration.TRUEFORGE_MTLS_ENABLED) {
    app.use('*', createClientCertificateMiddleware(deps.logger));
  }
  // Standalone sessions are cookies, so reject foreign Hosts and cross-origin writes before any router.
  if (configuration.STANDALONE && authEnabled) {
    app.use(
      '*',
      createRequestGuardMiddleware({
        port: configuration.PORT,
        publicBaseUrl: getPublicBaseUrl(),
        allowedOrigins: getAllowedOrigins(),
        ...(configuration.OIDC !== undefined && configuration.LOGIN_UPSTREAM_URL !== ''
          ? { loginGatewayUrl: configuration.OIDC.OIDC_ISSUER_URL }
          : {}),
        ...(configuration.OIDC !== undefined && getAllowedOrigins().length > 0
          ? { loginPath: new URL(configuration.OIDC.OIDC_ISSUER_URL).pathname.replace(/\/$/, '') }
          : {}),
      }),
    );
  }
  // Connector sign-in returns to the listed address the request came to, however deep in the request it is built.
  if (configuration.STANDALONE && getAllowedOrigins().length > 0) {
    app.use('*', listedOriginMiddleware(getAllowedOrigins));
  }
  // Data import uploads an archive, so its path gets the import cap instead
  // of the general request body cap.
  const requestBodyLimit = createRequestBodyLimitMiddleware(configuration.MAX_REQUEST_BODY_BYTES);
  const importBodyLimit = createRequestBodyLimitMiddleware(configuration.DATA_IMPORT_MAX_BYTES);
  const bodyLimitDispatcher: MiddlewareHandler = (c, next) =>
    c.req.path === '/api/v1/data/import' ? importBodyLimit(c, next) : requestBodyLimit(c, next);
  app.use('*', bodyLimitDispatcher);

  // The app serves its sign-in service itself, so password guessing is limited: under every listed address for an
  // instance opened on the network, or under the issuer's public address when LOGIN_UPSTREAM_URL says where it runs.
  if (configuration.STANDALONE && configuration.OIDC !== undefined) {
    const issuerUrl = configuration.OIDC.OIDC_ISSUER_URL;
    const issuerPath = new URL(issuerUrl).pathname.replace(/\/$/, '');
    if (getAllowedOrigins().length > 0 && isProxiableIssuer(issuerUrl)) {
      app.all(
        `${issuerPath}/*`,
        createLoginProxy({
          issuerUrl,
          allowedOrigins: getAllowedOrigins(),
          trustedProxies: configuration.TRUSTED_PROXY_ADDRESSES,
        }),
      );
    } else if (configuration.LOGIN_UPSTREAM_URL !== '') {
      app.all(
        `${issuerPath}/*`,
        createLoginProxy({
          issuerUrl,
          upstreamUrl: configuration.LOGIN_UPSTREAM_URL,
          trustedProxies: configuration.TRUSTED_PROXY_ADDRESSES,
          allowedOrigins: [new URL(issuerUrl).origin],
        }),
      );
    }
  }

  app.get('/healthz', c => c.json({ status: 'ok', version: PACKAGE_VERSION, eval_mode: configuration.AMAN_EVAL_MODE }));
  mountCatalogLogos(app, {
    logos: [...deps.modelCatalog.list(), ...deps.mcpCatalog.list()].map(entry => entry.logo),
    authMiddleware: createUiSessionAuthMiddleware(deps.authenticator),
  });

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
    '/api/v1/help',
    withAuth(
      createHelpRouter({
        resolveRequestContext,
        resolveModelProviderStore: deps.resolveModelProviderStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
        tokenStore: deps.tokenStore,
        globalSettingsStore: deps.globalSettingsStore,
        googleConnectionStore: deps.googleConnectionStore,
        hostReportPath: configuration.HOST_REPORT_PATH,
        schedulerStatus: deps.schedulerStatus,
        logger: deps.logger,
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
        mcpCatalog: deps.mcpCatalog,
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
    '/api/v1/data',
    withAuth(
      createDataExportRouter({
        sessionStore: deps.sessionStore,
        personaStore: deps.personaStore,
        personalizationStore: deps.personalizationStore,
        spaceStore: deps.spaceStore,
        scheduleStore: deps.scheduleStore,
        globalSettingsStore: deps.globalSettingsStore,
        sentinelSettingsStore: deps.sentinelSettingsStore,
        sentinelAuditStore: deps.sentinelAuditStore,
        turnArtifactStore: deps.turnArtifactStore,
        tokenStore: deps.tokenStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveAgentStore: deps.resolveAgentStore,
        authorizer: deps.authorizer,
        outboundSecrets: deps.outboundSecrets,
        logger: deps.logger,
      }),
      authMiddleware,
    ),
  );
  // Only the import path is admin-only, so the export route next to it keeps its own answers.
  app.use('/api/v1/data/import', adminAuthMiddleware);
  app.route(
    '/api/v1/data',
    createDataImportRouter({
      sessionStore: deps.sessionStore,
      personaStore: deps.personaStore,
      personalizationStore: deps.personalizationStore,
      spaceStore: deps.spaceStore,
      scheduleStore: deps.scheduleStore,
      globalSettingsStore: deps.globalSettingsStore,
      sentinelAuditStore: deps.sentinelAuditStore,
      turnArtifactStore: deps.turnArtifactStore,
      tokenStore: deps.tokenStore,
      resolveMcpServerStore: deps.resolveMcpServerStore,
      resolveAgentStore: deps.resolveAgentStore,
      mcpCatalog: deps.mcpCatalog,
      withTransaction: deps.withTransaction,
      authorizer: deps.authorizer,
      logger: deps.logger,
    }),
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
        mcpCatalog: deps.mcpCatalog,
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
    '/api/v1/user/audit-log',
    withAuth(
      createAuditLogRouter({
        sentinelAuditStore: deps.sentinelAuditStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/user/brief-items',
    withAuth(
      createBriefItemsRouter({
        briefItemStore: deps.briefItemStore,
        audit: deps.sentinelAuditStore,
        sessionStore: deps.sessionStore,
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
  // Browser session only: bearer credentials (agents, sandboxes, API clients) are refused. Every route is
  // authenticated, including the browser callback, whose redirect carries the cookie that ties it to the
  // user who started the consent.
  app.route(
    GOOGLE_ROUTES_BASE_PATH,
    withAuth(
      createGoogleRouter({
        fetchImpl: undefined,
        googleConnectionStore: deps.googleConnectionStore,
        resolveRequestContext,
        logger: deps.logger,
      }),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  // Browser session only and admin only: the Email and Calendar accounts belong to the whole instance, so a
  // member of a shared server must not read or change them. Their app passwords pass through the save call
  // to the sidecars only.
  app.route(
    EMAIL_SETTINGS_BASE_PATH,
    withAuth(
      withAdminAuth(
        createEmailAccountRouter({
          fetchImpl: undefined,
          logger: deps.logger,
          mcpServerStore: deps.resolveMcpServerStore(),
        }),
        adminAuthMiddleware,
      ),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  app.route(
    CALENDAR_SETTINGS_BASE_PATH,
    withAuth(
      withAdminAuth(
        createCalendarAccountRouter({
          fetchImpl: undefined,
          logger: deps.logger,
          mcpServerStore: deps.resolveMcpServerStore(),
        }),
        adminAuthMiddleware,
      ),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  // Same-origin tile proxy for embedded maps. Browser session only: bearer
  // credentials (agents, sandboxes, API clients) are refused.
  app.route(
    '/api/maps',
    withAuth(
      createMapsRouter({
        sentinelSettingsStore: deps.sentinelSettingsStore,
        globalSettingsStore: deps.globalSettingsStore,
        resolveRequestContext,
        logger: deps.logger,
      }),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  // Chat images, browser session only like the tile proxy: no agent or API token can approve a card.
  app.route(
    '/api/chat-images',
    withAuth(
      createChatImagesRouter({
        sessions: deps.sessions,
        chatImages: deps.chatImages,
        resolveRequestContext,
        logger: deps.logger,
      }),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  // Space pictures, browser session only: the owner\'s own spaces link them, and no agent or API token may fetch on the person\'s behalf.
  app.route(
    '/api/space-pictures',
    withAuth(
      createSpacePicturesRouter({
        tenantId: TENANT_ID,
        pictures: createSpacePictureService({
          spaceStore: deps.spaceStore,
          fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
          now: () => Date.now(),
        }),
        resolveRequestContext,
      }),
      createUiSessionAuthMiddleware(deps.authenticator),
    ),
  );
  // Chat-page pictures, browser session only: only a link the chat itself saw, read back from its
  // stored turns, and no agent or API token may fetch on the person\'s behalf.
  app.route(
    '/api/chat-pictures',
    withAuth(
      createChatPicturesRouter({
        pictures: createChatPictureService({
          sessionStore: deps.sessionStore,
          fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
          now: () => Date.now(),
        }),
        sessions: deps.sessions,
        resolveRequestContext,
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
        ensureAmanGuide: ensureAmanGuideFor,
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
    '/api/v1/spaces',
    withAuth(
      createSpaceFolderAssignmentsRouter({
        spaceStore: deps.spaceStore,
        resolveRequestContext,
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/space-folders',
    withAuth(
      createSpaceFoldersRouter({
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
        mcpCatalog: deps.mcpCatalog,
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
        resolveAgentStore: deps.resolveAgentStore,
        resolveMcpServerStore: deps.resolveMcpServerStore,
        resolveWorkspaceDir: async ({ c, session_id }) => {
          const resolver = deps.sandboxProviderResolver ?? resolveSandboxProvider;
          const provider = await resolver({
            tenant_id: TENANT_ID,
            store: deps.resolveSandboxProviderStore(c),
            logger: deps.logger,
            sessionId: session_id,
          });
          return provider?.getWorkspaceDir();
        },
        resolveCheckoutExists: ({ c, session_id, workspace_cwd }) =>
          resolveCheckoutExistsInSessionSandbox({
            deps: {
              sessionStore: deps.sessionStore,
              logger: deps.logger,
              sandboxProviderResolver: deps.sandboxProviderResolver,
              resolveSandboxProviderStore: deps.resolveSandboxProviderStore,
            },
            c,
            session_id,
            workspace_cwd,
          }),
      }),
      authMiddleware,
    ),
  );
  app.route(
    '/api/v1/sessions',
    withAuth(
      createTurnsRouter({
        mcpCatalog: deps.mcpCatalog,
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
        googleConnectionStore: deps.googleConnectionStore,
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
        schedules: configuration.STANDALONE
          ? { store: deps.scheduleStore, withTransaction: deps.withTransaction }
          : undefined,
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

  // Resolves once the guide installs started at boot and by requests so far have finished.
  return Object.assign(app, {
    guidesSettled: async (): Promise<void> => {
      await bootGuides;
      await seedGuide.settled();
    },
  });
}
