/**
 * DB-backed turns API (mounted at /api/v1/sessions).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore, Sessions, Turn, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  ApprovalRequestEndedError,
  CancellationReason,
  EventType,
  PreviousTurnRunningError,
  SessionStoreConflictError,
  SessionStoreNotFoundError,
  StaleApprovalContinuationError,
  TurnAlreadyExistsError,
  withoutClearedApprovals,
  type SessionHandle,
  type TurnHandle,
  type TurnInputItem,
  type TurnRecordWithoutSnapshot,
} from '@truefoundry/trueforge-core/agent-session';
import {
  AgentHarnessError,
  existingSandboxIdForProvider,
  extractErrorLogFields,
  HeldActionRefusedError,
  isAgentInputUserMessage,
  isFileContentPart,
  McpConnectionError,
  rawSandboxId,
  redisKey,
  SandboxError,
  SandboxFileNotFoundError,
  SandboxNotAvailableError,
  VercelAILLM,
  type BoundRepository,
  type HeldRefusalReason,
} from '@truefoundry/trueforge-core/core';
import { upgradeStoredTurnState } from '@truefoundry/trueforge-core/core/permissions/storedCards';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { ulid } from 'ulid';
import type { Logger } from 'winston';
import type { Authorizer } from '../auth/authorizer';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import type { McpCatalog } from '../catalog/McpCatalog';
import configuration, { getRunCodeToolCallTimeoutMs, isTrueFoundryModeEnabled } from '../config';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { ICompletedTurnEventStore } from '../db/completedTurnEvents';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IRepositoryStore } from '../db/repositoryStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISkillStore } from '../db/skillStore';
import type { ISpaceStore } from '../db/spaceStore';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import type { PersonaKnowledgeHit } from '../personaKnowledge/knowledgeRetrieval';
import type { PersonalizationProfile } from '../personalization/profile';
import type { PersonaContext } from '../personas/persona';
import {
  createAndExecuteTurnRoute,
  downloadSandboxFileRoute,
  getTurnRoute,
  listTurnArtifactsRoute,
  listTurnEventsRoute,
  listTurnsRoute,
  subscribeTurnRoute,
} from '../routes/turnRoutes';
import type { ActiveTurnRegistry } from '../runtime/activeTurns';
import { findTurnArtifact } from '../runtime/artifacts/findTurnArtifact';
import { submitArtifactPersistence } from '../runtime/artifacts/persistTurnArtifacts';
import { chatModelName, resolveChatAssistant, scheduleRunsAs, type ChatRunner } from '../runtime/chatAssistant';
import { StreamGoneError, type EventSubscription, type EventSubscriptionRegistry } from '../runtime/event-subscription';
import { envManagedHelperModelFqn } from '../runtime/helperModelRouting';
import { buildInternalSourceToolPolicy, type InternalSourceState } from '../runtime/internalSourceGuard';
import { chatTitleContext } from '../runtime/memory/chatTitleContext';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { resolveMemoryProvider } from '../runtime/memory/memoryProvider';
import {
  submitRetainWithVerification,
  type RetainOutcomeLog,
  type SummarizeTurnContext,
} from '../runtime/memory/memoryRetain';
import { applyMemorySettings } from '../runtime/memory/memorySettings';
import { applyMemoryScreenOverride, readMemoryScreenSetting } from '../runtime/memoryScreenSettings';
import { resolveTurnSummarizeContext } from '../runtime/memorySummarizeSettings';
import {
  flushModelUsage,
  modelIdentity,
  TurnModelUsageLedger,
  UsageRecordingLLM,
  type ModelUsageDrainMember,
  type TurnModelUsage,
} from '../runtime/modelUsage';
import { mintPeeredTurnId } from '../runtime/peeringIds';
import type { PersonaTurnContext } from '../runtime/personaCapability';
import type { PersonaSwitchNotice } from '../runtime/PersonaTurnResourceResolver';
import {
  profileLearningPassConfig,
  resolveTurnModelFqn,
  submitProfileLearning,
  type ProfileLearningDrainMember,
} from '../runtime/profileLearning';
import { synchronizeRepositoryCommandProposals } from '../runtime/repositoryCommandProposals';
import { validateSandboxFilePath } from '../runtime/sandboxFilePath';
import type { ScheduleStoreAccess, ScheduleTurnContext } from '../runtime/scheduleCapability';
import {
  applyTokenFactoryRouting,
  buildGatewayMetadata,
  buildTurnSandbox,
  gatewayMetadataHeaders,
  getMcpConnection,
  getModelDetails,
  isGithubConnectorAttached,
  isWebConnectorAttached,
  RepositoryBindingResolutionError,
  resolveBoundRepository,
  resolveGithubGitToken,
  resolveGitSkills,
  resolveSandboxProvider,
  withGatewayMetadataHeaders,
} from '../runtime/sessionResources';
import { SpaceTurnResourceResolver } from '../runtime/spaceCapability';
import { TokenFactoryMeteredLLM, tokenFactoryRole, type TokenFactoryBudget } from '../runtime/tokenFactoryBudget';
import { resolveToolOutputScreenEnabled } from '../runtime/toolOutputScreenSettings';
import type { TurnDrainRegistry } from '../runtime/turnDrains';
import { TurnExecutionDeadline } from '../runtime/turnExecutionDeadline';
import { resolveTurnInternalSources } from '../runtime/turnInternalSources';
import { isTurnPersonaResolutionCurrent, resolveTurnPersona } from '../runtime/turnPersona';
import { packageMirrorTokens } from '../sandbox/mirrors/packageMirrorTokens';
import { checkSnapshotStatus } from '../sandbox/providerUtils';
import type { MemoryProviderSettings } from '../schemas/mcpServer';
import { canReadAgentBoundResource } from './agentAccess';
import { readServerSandboxAvailable } from './capabilities';

/** The small model helper jobs run on while a turn is on Token Factory; undefined when none is registered. */
function turnHelperModelFqn(): string | undefined {
  return envManagedHelperModelFqn({
    apiKey: configuration.NEBIUS_API_KEY,
    managedByTrueFoundry: isTrueFoundryModeEnabled(),
    model: configuration.TOKEN_FACTORY_MODEL,
    cheaperModel: configuration.TOKEN_FACTORY_CHEAPER_MODEL,
  });
}

export function toWireTurn<TCustom extends object>(record: TurnRecordWithoutSnapshot<TCustom>): Turn {
  return {
    id: record.turn_id,
    session_id: record.session_id,
    previous_turn_id: record.previous_turn_id,
    input: record.input,
    state: upgradeStoredTurnState(record.state),
    created_at: record.created_at.toISOString(),
  };
}

/**
 * Copies into a standalone ArrayBuffer for the response body: a pooled Buffer's
 * backing store is shared and typed as ArrayBufferLike, which is not a body.
 * Bounded by SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD.
 */
function toArrayBuffer(content: Buffer): ArrayBuffer {
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  return buffer;
}

/** What a person is told when the reply that offered a file is not in this chat. */
const MISSING_REPLY_MESSAGE = 'This reply could not be found. Reload the chat, then try again.';

/** What a person is told when no sandbox is set up to hold the file. */
const NO_SANDBOX_MESSAGE = 'The sandbox is turned off, so this file is not available. Turn on the sandbox in Settings.';

/** What a person is told when a file was never copied out of a workspace that has since been cleared. */
const CLEARED_WORKSPACE_MESSAGE =
  'This file was in a temporary workspace that has been cleared. Ask Aman to make it again.';

/**
 * Builds the Content-Disposition telling the browser to save the file under its sandbox name.
 *
 * A sandbox file can be named in any script, but an HTTP header can only carry bytes, so a name
 * like `中文.csv` cannot be written into the header as-is — doing so throws when the response is
 * constructed. RFC 6266's `filename*` exists for this: percent-encode the UTF-8 name so the value
 * stays plain ASCII, and the client decodes it back. Encoding also defuses quotes and newlines,
 * which could otherwise close the value or inject another header.
 */
export function toContentDisposition(path: string): string {
  // Trailing separators are dropped so a path ending in `/` still yields its last real segment.
  const fileName = path.split('/').filter(Boolean).pop() ?? 'download';
  // encodeURIComponent covers everything except these four, which RFC 5987 also disallows here.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * Machine-readable `error.code` values for a create-turn conflict. A client that resumes a
 * chat has to tell "your decision is stale, re-read the session" apart from "you contradicted
 * a decision already on record", and an HTTP status alone cannot say which.
 */
export const TurnConflictCode = {
  STALE_APPROVAL_CONTINUATION: 'stale_approval_continuation',
  PREVIOUS_TURN_RUNNING: 'previous_turn_running',
  TURN_ALREADY_EXISTS: 'turn_already_exists',
  APPROVAL_CONFLICT: 'approval_conflict',
  APPROVAL_REQUEST_ENDED: 'approval_request_ended',
} as const;

/** An answer to a held action that cannot run now; `error.code` says why, e.g. `held_action_expired`. */
export type HeldActionConflictCode = `held_action_${HeldRefusalReason}`;

export type TurnConflictCode = (typeof TurnConflictCode)[keyof typeof TurnConflictCode] | HeldActionConflictCode;

/** The conflict code for a store rejection, or null when the store raised one we do not name. */
export function turnConflictCodeFor(error: SessionStoreConflictError): TurnConflictCode | null {
  if (error instanceof StaleApprovalContinuationError) {
    return TurnConflictCode.STALE_APPROVAL_CONTINUATION;
  }
  if (error instanceof PreviousTurnRunningError) {
    return TurnConflictCode.PREVIOUS_TURN_RUNNING;
  }
  if (error instanceof TurnAlreadyExistsError) {
    return TurnConflictCode.TURN_ALREADY_EXISTS;
  }
  if (error instanceof ApprovalRequestEndedError) {
    return TurnConflictCode.APPROVAL_REQUEST_ENDED;
  }
  return null;
}

export interface TurnsRouterDeps {
  /** Shipped MCP catalog: tells a designated search provider's search tools and plumbing arguments. */
  mcpCatalog: McpCatalog;
  sessions: Sessions<SessionCustom, TurnCustom>;
  /** Post-completion passthrough appends ride the same store (see db/completedTurnEvents.ts). */
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  activeTurns: ActiveTurnRegistry;
  /** Tracks in-flight turn event drains so shutdown can wait for them. */
  turnDrains: TurnDrainRegistry;
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore;
  resolveMcpServerStore: (c: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore;
  resolveSkillStore: (c: Context) => ISkillStore;
  resolveAgentStore: (c: Context) => IAgentStore;
  /** Fork-only: not agent-scoped upstream, so these stay directly injected rather than resolved per-request. */
  tokenStore: IOAuthTokenStore;
  personalizationStore: IPersonalizationStore;
  personaStore: IPersonaStore;
  spaceStore: ISpaceStore;
  /** Per-user Google logins; absent, no Gmail tools mount. */
  googleConnectionStore?: IGoogleConnectionStore | undefined;
  repositoryStore: IRepositoryStore;
  turnArtifactStore: ITurnArtifactStore;
  /** Not tenant-scoped: the persisted live tool-output screen override is global. */
  globalSettingsStore: IGlobalSettingsStore;
  /** Per-instance daily Token Factory counters; refuses new turns past `TOKEN_FACTORY_DAILY_TOKEN_CAP`. */
  tokenFactoryBudget: TokenFactoryBudget;
  /** Resumable live turn-event transport: create-turn writes, subscribe polls. */
  eventSubscriptions: EventSubscriptionRegistry<TurnStreamingEvent>;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore;
  /** Composition seam for provider-backed integration tests and alternative hosts. */
  sandboxProviderResolver?: typeof resolveSandboxProvider | undefined;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
  authorizer: Authorizer;
  /** Present only where schedules run (standalone): chat turns then get the schedule tools. */
  schedules?: ScheduleStoreAccess | undefined;
}

/** Names only, bounded: enough for the model to know the host's catalog exists without inflating the prompt. */
const CONFIGURED_MODELS_PROMPT_LIMIT = 20;

/**
 * Deps needed to create a turn and drain events in-process (no HTTP). Carries already-resolved
 * stores; callers must resolve them from the request context (e.g. schedule `resolveTurnDeps(c, agent)`)
 * so TrueFoundry mode stays token-bound for models, MCP, and skills.
 */
export type BeginTurnExecutionDeps = Pick<
  TurnsRouterDeps,
  | 'activeTurns'
  | 'turnDrains'
  | 'eventSubscriptions'
  | 'logger'
  | 'globalSettingsStore'
  | 'mcpCatalog'
  | 'tokenFactoryBudget'
> & {
  agentStore: IAgentStore;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerWithAuthStore;
  sandboxProviderStore: ISandboxProviderStore;
  skillStore: ISkillStore;
  /** Fork-only: required unconditionally by createTurnResolver's memory/repository wiring. */
  tokenStore: IOAuthTokenStore;
  repositoryStore: IRepositoryStore;
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  spaceStore: ISpaceStore;
  /** Per-user Google logins; absent, no Gmail tools mount. */
  googleConnectionStore?: IGoogleConnectionStore | undefined;
  /** persists run_code's harvested result files as turn artifacts at harvest time. */
  turnArtifactStore: ITurnArtifactStore;
  /** Same override point as the chat path's `TurnsRouterDeps.sandboxProviderResolver`; defaults to {@link resolveSandboxProvider}. */
  sandboxProviderResolver?: typeof resolveSandboxProvider | undefined;
  /** Optional: absent for callers (e.g. schedule run-now) that do not resolve a memory/persona context. */
  personalizationProfile?: PersonalizationProfile | undefined;
  personaContext?: PersonaContext | undefined;
  boundRepository?: BoundRepository | undefined;
  memoryClient?: MemoryClient | undefined;
  memoryProviderServerName?: string | undefined;
  memorySettings?: MemoryProviderSettings | undefined;
  previousTurnId?: string | null;
  sessionTitle?: string | undefined;
  /** From CreateTurnRequest.client_timezone, or a schedule's own time zone for its runs. */
  clientTimezone?: string | undefined;
};

/**
 * Builds the per-turn resolver. Agent / MCP / sandbox / LLM lookups are wired
 * the same way: async factories over the corresponding stores.
 */
function createTurnResolver(deps: {
  mcpCatalog: McpCatalog;
  mcpServerStore: IMcpServerWithAuthStore;
  tokenStore: IOAuthTokenStore;
  skillStore: ISkillStore;
  sandboxProviderStore: ISandboxProviderStore;
  sandboxProviderResolver: typeof resolveSandboxProvider;
  agentStore: IAgentStore;
  modelProviderStore: IModelProviderStore;
  logger: Logger;
  signal: AbortSignal;
  userRef: string;
  session: SessionHandle<SessionCustom, TurnCustom>;
  turnId: string;
  personalizationProfile?: PersonalizationProfile | undefined;
  personaContext?: PersonaContext | undefined;
  personaKnowledgeBlock?: string | undefined;
  personaKnowledgeHits?: readonly PersonaKnowledgeHit[] | undefined;
  switchNotice?: PersonaSwitchNotice | undefined;
  /** Per-turn internal-source state shared by the knowledge lookup, recall, and the web_search policy. */
  internalSourceState: InternalSourceState;
  boundRepository?: BoundRepository | undefined;
  /** Whether this server has a sandbox at all, from the persisted sandbox status. See readServerSandboxAvailable. */
  serverSandboxAvailable: boolean;
  repositoryStore: IRepositoryStore;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  memoryClient?: MemoryClient | undefined;
  memoryProviderServerName?: string | undefined;
  memorySettings?: MemoryProviderSettings | undefined;
  previousTurnId?: string | null;
  sessionTitle?: string | undefined;
  spaceStore: ISpaceStore;
  /** Per-user Google logins; absent, no Gmail tools mount. */
  googleConnectionStore?: IGoogleConnectionStore | undefined;
  /** From CreateTurnRequest.client_timezone. See ITurnResourceResolver.clientTimezone. */
  clientTimezone?: string | undefined;
  /** persists run_code's harvested result files as turn artifacts at harvest time. */
  turnArtifactStore: ITurnArtifactStore;
  /**
   * Effective live tool-output screen on/off for this turn: the persisted override when one is
   * stored, else `TOOL_OUTPUT_SCREEN_ENABLED`, ANDed with a configured screening service —
   * unconfigured (no `MEMORY_SCREEN_URL`) is effectively off. Resolved once per turn by the
   * caller, never per tool call.
   */
  toolOutputScreenEnabled: boolean;
  /** Limits and counts the turn's Token Factory calls against the daily cap. */
  tokenFactoryBudget: TokenFactoryBudget;
  /** Receives every model call the turn makes, for the usage shown under the answer. */
  modelUsage: TurnModelUsage;
  /** Chat turns where schedules run; absent, no schedule tools mount. */
  schedules?: ScheduleTurnContext | undefined;
  /** Chat turns that have a model to answer with; absent, no specialist tool mounts. */
  personas?: PersonaTurnContext | undefined;
}): SpaceTurnResourceResolver {
  const {
    mcpCatalog,
    mcpServerStore,
    tokenStore,
    skillStore,
    sandboxProviderStore,
    sandboxProviderResolver,
    agentStore,
    modelProviderStore,
    logger,
    signal,
    userRef,
    session,
    turnId,
    personalizationProfile,
    personaContext,
    personaKnowledgeBlock,
    personaKnowledgeHits,
    switchNotice,
    internalSourceState,
    boundRepository,
    serverSandboxAvailable,
    repositoryStore,
    sessionStore,
    memoryClient,
    memoryProviderServerName,
    memorySettings,
    previousTurnId,
    sessionTitle,
    spaceStore,
    googleConnectionStore,
    turnArtifactStore,
    clientTimezone,
    toolOutputScreenEnabled,
    tokenFactoryBudget,
    modelUsage,
    schedules,
    personas,
  } = deps;
  const tenant_id = session.tenant_id;
  const sessionId = session.session_id;
  const metadataHeaders = isTrueFoundryModeEnabled()
    ? gatewayMetadataHeaders(buildGatewayMetadata({ session, turnId }))
    : {};
  return new SpaceTurnResourceResolver(
    {
      llm: async (name, role) => {
        const resolved = await getModelDetails({
          tenant_id,
          name,
          store: modelProviderStore,
        });
        const routed = applyTokenFactoryRouting({
          primary: resolved.providerConfig,
          mode: configuration.TOKEN_FACTORY_MODE,
          apiKey: configuration.NEBIUS_API_KEY,
          model: configuration.TOKEN_FACTORY_MODEL,
          baseUrl: configuration.TOKEN_FACTORY_BASE_URL,
        });
        // Gateway metadata is only meaningful to the TrueFoundry gateway, so it is
        // never sent to Token Factory (a different external party).
        const withMetadataHeaders = (providerConfig: typeof routed.providerConfig) => ({
          ...providerConfig,
          headers: {
            ...providerConfig.headers,
            ...(providerConfig.provider.type === 'tokenfactory' ? {} : metadataHeaders),
          },
        });
        const primaryIdentity = modelIdentity({ name, providerConfig: routed.providerConfig });
        const fallbackConfig = routed.fallbackProviderConfig;
        const fallbackIdentity =
          fallbackConfig === undefined ? undefined : modelIdentity({ name, providerConfig: fallbackConfig });
        // The identity is settled per call, because a call that failed over was answered by the fallback.
        const buildClient = ({ withFailover, onFailover }: { withFailover: boolean; onFailover: () => void }) => {
          let served = primaryIdentity;
          const client = new VercelAILLM({
            providerConfig: withMetadataHeaders(routed.providerConfig),
            ...(withFailover && fallbackConfig !== undefined && fallbackIdentity !== undefined
              ? {
                  fallbackProviderConfig: withMetadataHeaders(fallbackConfig),
                  onFallback: () => {
                    served = fallbackIdentity;
                    onFailover();
                  },
                }
              : {}),
            logger,
            signal,
            streamTimeout: resolved.streamTimeout,
          });
          return new UsageRecordingLLM({
            llm: client,
            onCall: usage => {
              modelUsage.record({ role, identity: served, usage });
            },
          });
        };
        const tokenFactoryRoleOfModel = tokenFactoryRole({
          primaryType: routed.providerConfig.provider.type,
          fallbackType: fallbackConfig?.provider.type,
        });
        const tokenFactoryConfig =
          tokenFactoryRoleOfModel === 'primary'
            ? routed.providerConfig
            : tokenFactoryRoleOfModel === 'fallback'
              ? fallbackConfig
              : undefined;
        // A new turn on a Token Factory model is refused up front once today's budget is gone; the
        // metered client re-checks before every model call after that.
        if (tokenFactoryRoleOfModel === 'primary') {
          await tokenFactoryBudget.assertWithinCap();
        }
        return {
          modelClient:
            tokenFactoryRoleOfModel === undefined || tokenFactoryConfig === undefined
              ? buildClient({ withFailover: true, onFailover: () => undefined })
              : new TokenFactoryMeteredLLM({
                  role: tokenFactoryRoleOfModel,
                  modelId: tokenFactoryConfig.model.id,
                  budget: tokenFactoryBudget,
                  logger,
                  build: buildClient,
                }),
          defaultModelParams: resolved.defaultModelParams,
          // The upstream identifier actually sent to the provider, not
          // `name` (the configured catalog alias), so the model-identity
          // prompt names what it really is.
          modelId: routed.providerConfig.model.id,
          // Absent means false, see ModelPropertiesSchema.vision.
          modelSupportsVision: resolved.modelProperties.vision ?? false,
        };
      },
      mcp: async name => {
        const connection = await getMcpConnection({
          tenant_id,
          name,
          store: mcpServerStore,
          tokenStore,
          clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
          userRef,
        });
        if (connection === undefined) {
          throw new HTTPException(422, {
            message: `Unknown MCP server "${name}" - not configured`,
          });
        }
        return {
          url: connection.url,
          headers: withGatewayMetadataHeaders({
            headers: connection.headers,
            metadataHeaders,
          }),
          first_party: connection.first_party,
          search_provider:
            connection.search_provider === undefined
              ? undefined
              : mcpCatalog.searchProviderGrant({ url: connection.url, storedTools: connection.search_provider.tools }),
        };
      },
      mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
      mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
      sandboxProvider: async ({ spec, existingSandboxId, tracing, sentinel }) => {
        const provider = await sandboxProviderResolver({
          tenant_id,
          store: sandboxProviderStore,
          logger,
          sessionId,
        });
        if (provider === undefined) {
          throw new HTTPException(422, {
            message: 'no sandbox provider configured, PUT /settings/sandbox-providers',
          });
        }
        const carriedSandboxId = existingSandboxIdForProvider({
          existingSandboxId,
          currentProviderType: provider.type,
        });
        // A fresh Daytona sandbox is cloned from the release snapshot, so the build must be ready first.
        // Slots attest themselves when the sandbox is created.
        // Restoring an existing sandbox goes through daytona.get and never touches the snapshot.
        // Local fallback has no image build.
        if (carriedSandboxId === undefined && provider.type !== 'local' && provider.type !== 'slots') {
          const status = await checkSnapshotStatus({ store: sandboxProviderStore, tenant_id, logger });
          if (status?.status !== 'ready') {
            throw new HTTPException(422, {
              message:
                status?.status === 'failed'
                  ? `sandbox image build failed (${status.status_reason ?? 'unknown error'})`
                  : 'sandbox image is activating, retry shortly',
            });
          }
        }
        const gitSkills = await resolveGitSkills({
          tenant_id,
          skills: spec.skills ?? [],
          store: skillStore,
        });
        // Sandbox slots are offline; their provider keeps the token on the host and runs git there.
        const githubGitToken = await resolveGithubGitToken({
          tenant_id,
          spec,
          store: mcpServerStore,
        });
        return buildTurnSandbox({
          provider,
          logger,
          gitSkills,
          githubGitToken,
          githubConnectorAttached: isGithubConnectorAttached(spec),
          webConnectorAttached: isWebConnectorAttached(spec),
          fileDownloadEnabled: spec.config.sandbox.file_downloads,
          existingSandboxId: carriedSandboxId,
          boundRepository,
          sentinel,
          loadBoundRepository:
            boundRepository === undefined
              ? undefined
              : async () => {
                  const currentSession = await sessionStore.getSession({
                    tenant_id,
                    session_id: sessionId,
                  });
                  if (currentSession?.created_by_subject.subject_id !== userRef) {
                    return undefined;
                  }
                  return resolveBoundRepository({
                    tenant_id,
                    created_by: userRef,
                    repository_id: currentSession.repository_id,
                    workspace_cwd: currentSession.workspace_cwd,
                    store: repositoryStore,
                  });
                },
          loadPackageMirrorToken:
            boundRepository === undefined
              ? undefined
              : async () => {
                  const currentSession = await sessionStore.getSession({
                    tenant_id,
                    session_id: sessionId,
                  });
                  if (currentSession?.created_by_subject.subject_id !== userRef) {
                    return undefined;
                  }
                  const repository = await repositoryStore.getRepository({
                    tenant_id,
                    created_by: userRef,
                    repository_id: boundRepository.repository_id,
                  });
                  if (repository === undefined) {
                    return undefined;
                  }
                  if (!repository.package_downloads_allowed) {
                    packageMirrorTokens.revokeRepository({
                      tenant_id,
                      created_by: userRef,
                      repository_id: repository.id,
                    });
                    return undefined;
                  }
                  return packageMirrorTokens.issue({
                    tenant_id,
                    created_by: userRef,
                    session_id: sessionId,
                    repository_id: repository.id,
                  });
                },
          loadPackageDownloadsAllowed:
            boundRepository === undefined
              ? undefined
              : async () => {
                  const currentSession = await sessionStore.getSession({
                    tenant_id,
                    session_id: sessionId,
                  });
                  if (currentSession?.created_by_subject.subject_id !== userRef) {
                    return false;
                  }
                  const repository = await repositoryStore.getRepository({
                    tenant_id,
                    created_by: userRef,
                    repository_id: boundRepository.repository_id,
                  });
                  return repository?.package_downloads_allowed ?? false;
                },
          allowPackageDownloads:
            boundRepository === undefined
              ? undefined
              : async () => {
                  const currentSession = await sessionStore.getSession({
                    tenant_id,
                    session_id: sessionId,
                  });
                  if (currentSession?.created_by_subject.subject_id !== userRef) {
                    return;
                  }
                  await repositoryStore.setPackageDownloadsAllowed({
                    tenant_id,
                    created_by: userRef,
                    repository_id: boundRepository.repository_id,
                    allowed: true,
                    expected_revision: undefined,
                  });
                },
          workspaceVerificationCoordinator: repositoryStore,
          workspaceLeaseOwnerId: configuration.EXECUTOR_ID,
          // run_code harvests persist as turn artifacts before cleanup.
          runCodeHarvestPersistence: {
            tenantId: tenant_id,
            sessionId,
            turnId,
            store: turnArtifactStore,
          },
          onRepositorySources:
            boundRepository === undefined
              ? undefined
              : observation =>
                  synchronizeRepositoryCommandProposals({
                    tenant_id,
                    created_by: userRef,
                    repository_id: boundRepository.repository_id,
                    sources: observation.sources,
                    store: repositoryStore,
                    signal: observation.signal,
                  }),
          tracing,
        });
      },
      agent: async agentId => {
        const record = await agentStore.getAgent({ tenant_id, id: agentId });
        if (record === undefined) {
          throw new HTTPException(422, { message: `Agent not found: ${agentId}` });
        }
        return record.manifest;
      },
      logger,
      boundRepository,
      serverSandboxAvailable,
      clientTimezone,
      compactionThresholdTokensDefault: configuration.CONTEXT_COMPACTION_THRESHOLD_TOKENS,
      toolDispatchMaxConcurrency: configuration.TOOL_DISPATCH_MAX_CONCURRENCY,
      toolCallTimeoutMs: configuration.TOOL_CALL_TIMEOUT_MS,
      // run_code's own provisioning-sized deadline, derived from the sandbox
      // bounds — the 21-minute bound is scoped to sandbox/run_code alone.
      runCodeToolCallTimeoutMs: getRunCodeToolCallTimeoutMs(),
      modelFirstResponseTimeoutMs: configuration.MODEL_FIRST_RESPONSE_TIMEOUT_MS,
      // Host-owned facts, capped and named-only, for the model-identity
      // section: what the host actually has configured, not what the model
      // is asked to believe about itself.
      configuredModels: async () => {
        const models = await modelProviderStore.listModels({ tenant_id });
        return models.slice(0, CONFIGURED_MODELS_PROMPT_LIMIT).map(model => ({
          modelId: model.model_id,
          provider: model.provider.name,
        }));
      },
      compactionContext: {
        getTaskChecklist: () => sessionStore.getTaskChecklist({ tenant_id, session_id: sessionId }),
        replaceTaskChecklist: input =>
          sessionStore.replaceTaskChecklist({ tenant_id, session_id: sessionId, ...input }),
      },
      // Once the persona library or recall has spoken (or been asked and had
      // nothing), web_search can no longer substitute for them. Enforced at
      // dispatch, not by instruction compliance.
      toolCallPolicy: buildInternalSourceToolPolicy(internalSourceState, logger),
    },
    personalizationProfile,
    personaContext,
    {
      client: memoryClient,
      config: applyMemorySettings(memorySettings, {
        recallMaxTokens: configuration.MEMORY_RECALL_MAX_TOKENS,
        recallEntityTokens: configuration.MEMORY_RECALL_ENTITY_TOKENS,
        recallTimeoutMs: configuration.MEMORY_RECALL_TIMEOUT_MS,
        recallQueryWindow: configuration.MEMORY_RECALL_QUERY_WINDOW,
        recallMinScore: configuration.MEMORY_RECALL_MIN_SCORE,
        recallMaxItems: configuration.MEMORY_RECALL_MAX_ITEMS,
        recallMaxEntities: configuration.MEMORY_RECALL_MAX_ENTITIES,
        preRecallGateEnabled: configuration.MEMORY_PRERECALL_GATE_ENABLED,
        retainTimeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
        sweepMaxPerTurn: configuration.MEMORY_SWEEP_MAX_PER_TURN,
        screen: {
          enabled: configuration.MEMORY_SCREEN_ENABLED,
          url: configuration.MEMORY_SCREEN_URL,
          authToken: configuration.MEMORY_SCREEN_AUTH_TOKEN,
          threshold: configuration.MEMORY_SCREEN_THRESHOLD,
          timeoutMs: configuration.MEMORY_SCREEN_TIMEOUT_MS,
          maxConcurrency: configuration.MEMORY_SCREEN_MAX_CONCURRENCY,
        },
        curated: {
          enabled: configuration.MEMORY_CURATED_ENABLED,
          maxModels: configuration.MEMORY_CURATED_MAX_MODELS,
          maxTokens: configuration.MEMORY_CURATED_MAX_TOKENS,
        },
        reflect: {
          enabled: configuration.MEMORY_REFLECT_ENABLED,
          budget: configuration.MEMORY_REFLECT_BUDGET,
          maxTokens: configuration.MEMORY_REFLECT_MAX_TOKENS,
          timeoutMs: configuration.MEMORY_REFLECT_TIMEOUT_MS,
        },
      }),
      sessionId,
      previousTurnId: previousTurnId ?? null,
      sessionTitle,
      providerServerName: memoryProviderServerName,
      searchProviderServerName: async () => {
        const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
        return servers.find(server => server.manifest.type === 'remote' && server.manifest.search_provider === true)
          ?.name;
      },
      // Will be derived from spec.config.memory.recall_enabled in resolveAgentDefinition
      recallEnabled: undefined,
      internalSourceState,
    },
    {
      enabled: toolOutputScreenEnabled,
      url: configuration.MEMORY_SCREEN_URL,
      authToken: configuration.MEMORY_SCREEN_AUTH_TOKEN,
      threshold: configuration.MEMORY_SCREEN_THRESHOLD,
      timeoutMs: configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS,
    },
    personaKnowledgeBlock,
    personaKnowledgeHits,
    switchNotice,
    {
      store: spaceStore,
      googleConnections: googleConnectionStore,
      authority: { tenantId: tenant_id, userRef },
      sessionId,
      schedules,
      personas,
      logger,
    },
    { store: turnArtifactStore, tenantId: tenant_id, sessionId, turnId, logger },
    { sessionStore, budget: tokenFactoryBudget, authority: { tenantId: tenant_id, userRef } },
  );
}

const MAX_SESSION_TITLE_LENGTH = 50;

/** Grapheme segmentation for title truncation (locale-independent per UAX #29). */
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Caps a title at MAX_SESSION_TITLE_LENGTH UTF-16 units without splitting a
 * grapheme cluster: clusters that would cross the cap (emoji with skin tones or
 * ZWJ sequences, which read as one unit but span several) are dropped whole.
 */
function truncateSessionTitle(title: string): string {
  let truncated = '';
  let length = 0;
  for (const { segment } of titleSegmenter.segment(title)) {
    if (length + segment.length > MAX_SESSION_TITLE_LENGTH) {
      break;
    }
    truncated += segment;
    length += segment.length;
  }
  return truncated;
}

/**
 * Derives a session title from the first user message of the first turn. Returns the
 * trimmed text (capped at {@link MAX_SESSION_TITLE_LENGTH}) or `undefined` when no usable
 * text is present (e.g. file-only or tool-approval input).
 */
export function deriveSessionTitle(input: TurnInputItem[] | undefined): string | undefined {
  const firstUserMessage = input?.find(isAgentInputUserMessage);
  if (!firstUserMessage) {
    return undefined;
  }

  const text =
    typeof firstUserMessage.content === 'string'
      ? firstUserMessage.content
      : firstUserMessage.content
          .filter(part => !isFileContentPart(part))
          .map(part => part.text)
          .join(' ');

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const title = truncateSessionTitle(trimmed);
  // A single cluster longer than the cap truncates to nothing; treat it as no usable title
  // so the store keeps the title unset instead of persisting a blank first-write-wins value.
  if (!title) {
    return undefined;
  }
  return title;
}

/** True when any user message in a create-turn input carries an attached file. */
function inputAttachesFiles(input: TurnInputItem[]): boolean {
  return input
    .filter(isAgentInputUserMessage)
    .some(message => typeof message.content !== 'string' && message.content.some(isFileContentPart));
}

/**
 * Full (uncapped) text of every user message in a create-turn input, concatenated in order and
 * joined with a blank line, or `''` when there is none. A turn's input can carry several user
 * messages (e.g. queued follow-ups sent before the previous turn finished); retention must not
 * silently drop any but the first.
 */
export function extractUserMessageText(input: TurnInputItem[] | undefined): string {
  const userMessages = input?.filter(isAgentInputUserMessage) ?? [];
  return userMessages
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter(part => !isFileContentPart(part))
            .map(part => part.text)
            .join(' '),
    )
    .join('\n\n');
}

/**
 * SSE payload for one turn event. The `id` field carries the per-stream
 * sequence number; the event body itself is not numbered (yield order is
 * persist order, so the transport boundary stamps).
 */
export function turnEventSsePayload(event: TurnStreamingEvent, sequenceNumber: number): { id: string; data: string } {
  return {
    id: String(sequenceNumber),
    data: JSON.stringify(event),
  };
}

/**
 * turn.created arms the active-run TTL, turn.done shortens it to the
 * post-completion drain window; mid-run events leave the TTL untouched.
 */
export function streamTTLSecondsFor(event: TurnStreamingEvent): number | undefined {
  if (event.type === EventType.TURN_CREATED) {
    return configuration.TURN_STREAM_TTL_SECONDS;
  }
  if (event.type === EventType.TURN_DONE) {
    return configuration.TURN_STREAM_POST_COMPLETION_TTL_SECONDS;
  }
  return undefined;
}

/** Redis/in-memory key for one turn's resumable event stream. */
export function turnStreamId(tenantId: string, sessionId: string, turnId: string): string {
  return redisKey('agent', 'turn', tenantId, sessionId, turnId, 'stream');
}

/**
 * Dual-write turn events to the resumable subscription registry, then optionally
 * forward each sequenced event (SSE path). Shared by streaming and non-streaming
 * create-turn; the HTTP response lifecycle does not own execution.
 */
/** Plain-text content of an assistant model message, `openai` chat-completion shaped. */
function formatAssistantMessageText(
  content: string | ({ type: 'text'; text: string } | { type: 'refusal'; refusal: string })[] | null | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!content) {
    return '';
  }
  return content.map(part => (part.type === 'text' ? part.text : part.refusal)).join('\n');
}

/**
 * Re-reads the just-completed turn for its sandbox id, resolves the tenant's sandbox provider,
 * and hands both to `submitArtifactPersistence`. Kept separate from that function (which only
 * needs a provider and a sandbox id it already has) because resolving those two is itself
 * fallible in ways that must never surface as a turn failure — the same never-throw contract as
 * `submitRetainWithVerification`: this never throws.
 */
async function resolveAndSubmitArtifactPersistence(params: {
  turnArtifactStore: ITurnArtifactStore;
  sandboxProviderStore: ISandboxProviderStore;
  sandboxProviderResolver: typeof resolveSandboxProvider;
  sessions: Sessions<SessionCustom, TurnCustom>;
  tenantId: string;
  sessionId: string;
  turnId: string;
  assistantText: string;
  logger: Logger;
}): Promise<void> {
  const {
    turnArtifactStore,
    sandboxProviderStore,
    sandboxProviderResolver,
    sessions,
    tenantId,
    sessionId,
    turnId,
    assistantText,
    logger,
  } = params;
  try {
    const session = await sessions.get({ tenant_id: tenantId, session_id: sessionId });
    const turn = await session?.getTurn(turnId);
    const sandboxId = turn?.record.snapshot.sandbox_info?.sandbox_id;
    if (sandboxId === undefined) {
      return;
    }
    const provider = await sandboxProviderResolver({
      tenant_id: tenantId,
      store: sandboxProviderStore,
      logger,
      sessionId,
    });
    if (provider === undefined) {
      return;
    }
    await submitArtifactPersistence({
      store: turnArtifactStore,
      provider,
      sandboxId,
      tenantId,
      sessionId,
      turnId,
      assistantText,
      logger,
    });
  } catch (error) {
    logger.error('Sandbox artifact persistence failed to start', {
      ...extractErrorLogFields(error),
      sessionId,
      turnId,
    });
  }
}

/** Outcome logging for an interactive turn: its retain persona, and the store to read the chat's persona after it. */
export interface TurnOutcomeLog extends RetainOutcomeLog {
  personaStore: Pick<IPersonaStore, 'getSessionPersona'>;
  tenantId: string;
}

/**
 * Logs when the turn's memory went to the vault of the persona it started with but the chat
 * ended under another (a `use_persona` switch during the turn).
 */
async function logTurnPersonaSwitch(params: {
  outcomeLog: TurnOutcomeLog;
  sessionId: string;
  turnId: string;
  logger: Logger;
}): Promise<void> {
  const { outcomeLog, sessionId, turnId, logger } = params;
  let activePersonaName: string;
  try {
    const active = await outcomeLog.personaStore.getSessionPersona({
      tenant_id: outcomeLog.tenantId,
      session_id: sessionId,
    });
    activePersonaName = active?.persona_name ?? 'shared';
  } catch (error) {
    logger.warn('Could not read the chat persona after a turn; persona switch not checked', {
      sessionId,
      turnId,
      ...extractErrorLogFields(error),
    });
    return;
  }
  if (activePersonaName === outcomeLog.personaName) {
    return;
  }
  logger.info('Turn memory saved under the persona the turn started with', {
    sessionId,
    turnId,
    personaName: outcomeLog.personaName,
    activePersonaName,
    reason: 'persona_switched',
  });
}

/**
 * Inputs for drainTurnEvents. `turnDrains` tracks the drain so shutdown can wait for
 * the TURN_DONE submissions (memory retain, profile learning, artifact persistence) instead
 * of dropping them when a SIGTERM lands in the drain window.
 */
export interface DrainTurnEventsInput {
  trackedStream: AsyncIterable<TurnStreamingEvent>;
  turnEventStream: EventSubscription<TurnStreamingEvent>;
  sessionId: string;
  turnId: string;
  executionDeadline: TurnExecutionDeadline;
  logger: Logger;
  turnDrains: TurnDrainRegistry;
  onEvent?: (event: TurnStreamingEvent, sequenceNumber: number) => Promise<void>;
  /** Present only when a memory provider resolved for this turn; the drain awaits the retain. */
  memory?:
    | {
        client: MemoryClient;
        userText: string;
        /** The turn's input carried an attached file, whose extracted text reaches the model as data. */
        attachedFiles: boolean;
        sessionTitle: string | undefined;
        /**
         * Present only when turn summarization is enabled (the Settings toggle's
         * persisted override, else the `MEMORY_SUMMARIZE` env default); the retain path
         * summarizes the turn via the LLM before writing. Absent means verbatim (the default).
         */
        summarize?: SummarizeTurnContext | undefined;
        /** Present only for interactive turns; scheduled turns log nothing at info. */
        outcomeLog?: TurnOutcomeLog | undefined;
      }
    | undefined;
  /** Present on every turn: the model usage the turn recorded, persisted when it completes. */
  modelUsage?: ModelUsageDrainMember | undefined;
  /** Present only when profile learning is enabled; the drain awaits the pass. */
  profileLearning?: ProfileLearningDrainMember | undefined;
  /**
   * Present on every turn (unconditionally, unlike memory/profile learning): a turn that never
   * declared a sandbox_artifacts block is a no-op inside submitArtifactPersistence, so there is no
   * cheaper precondition to gate this on at the call site.
   */
  artifacts?:
    | {
        turnArtifactStore: ITurnArtifactStore;
        sandboxProviderStore: ISandboxProviderStore;
        sandboxProviderResolver: typeof resolveSandboxProvider;
        sessions: Sessions<SessionCustom, TurnCustom>;
        tenantId: string;
      }
    | undefined;
}

export async function drainTurnEvents(input: DrainTurnEventsInput): Promise<void> {
  const drain = runTurnEventDrain(input);
  input.turnDrains.track({ sessionId: input.sessionId, turnId: input.turnId, drain });
  return drain;
}

async function runTurnEventDrain(input: DrainTurnEventsInput): Promise<void> {
  const {
    trackedStream,
    turnEventStream,
    sessionId,
    turnId,
    executionDeadline,
    logger,
    onEvent,
    memory,
    artifacts,
    profileLearning,
    modelUsage,
  } = input;
  // Provenance for the memory the retain below writes. All tool output is untrusted data (the
  // host says so in the system prompt), and the retained assistant reply is produced after seeing
  // it, so a turn that ingested any tool result is stamped `tool_ingested` and held to the recall
  // screen's stricter posture. Text extracted from an attached file is just as untrusted, so a
  // turn that attached one starts out tainted. A turn with neither is the user's own voice:
  // `user_stated`.
  let ingestedToolOutput = memory?.attachedFiles === true;
  try {
    for await (const event of trackedStream) {
      if (event.type === EventType.TOOL_RESPONSE || event.type === EventType.TOOL_RESPONSE_V2) {
        ingestedToolOutput = true;
      }
      // Dual-write before any client sink so subscribers can resume after disconnect.
      const sequenceNumber = await turnEventStream.put(event, {
        streamTTLSeconds: streamTTLSecondsFor(event),
      });
      await onEvent?.(event, sequenceNumber);
      if (event.type === EventType.TURN_DONE && event.state.status === 'done') {
        // First, so the answer's usage is visible before the slower follow-up work below.
        const flushUsage = async () => {
          if (modelUsage !== undefined) {
            await flushModelUsage({ member: modelUsage, sessionId, turnId, turnEventStream, logger });
          }
        };
        await flushUsage();
        if (memory !== undefined) {
          // Awaited (not void): the drain's tracked promise covers this, so shutdown waits for
          // it, and the verification pass inside retries a failed retain once.
          const stored = await submitRetainWithVerification({
            client: memory.client,
            sessionId,
            turnId,
            userText: memory.userText,
            assistantText: formatAssistantMessageText(event.state.output?.content),
            completedAt: event.state.completed_at,
            sessionTitle: memory.sessionTitle,
            origin: ingestedToolOutput ? 'tool_ingested' : 'user_stated',
            logger,
            summarize: memory.summarize,
            outcomeLog: memory.outcomeLog,
          });
          // Only a stored turn can have gone to the persona it started with; a skipped or failed
          // retain is already explained by its own reason line.
          if (stored && memory.outcomeLog !== undefined) {
            await logTurnPersonaSwitch({ outcomeLog: memory.outcomeLog, sessionId, turnId, logger });
          }
        }
        if (profileLearning !== undefined) {
          // The assistant's reply is deliberately not passed here: it is not a source of facts
          // about the user, so the learning pass only ever sees the user's own turn text.
          // Awaited so the tracked drain covers the pass; the pass writes its audit event to
          // the turnEventStream (how an open tab sees it without reloading the turn).
          await submitProfileLearning({
            ...profileLearning,
            sessionId,
            turnId,
            completedAt: event.state.completed_at,
            turnEventStream,
            logger,
          });
        }
        // The summarization and profile learning calls above record after the first flush.
        await flushUsage();
        if (artifacts !== undefined) {
          await resolveAndSubmitArtifactPersistence({
            ...artifacts,
            sessionId,
            turnId,
            assistantText: formatAssistantMessageText(event.state.output?.content),
            logger,
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof SessionStoreNotFoundError) {
      logger.warn('Turn stream ended after session/turn was removed', {
        sessionId,
        turnId,
        ...extractErrorLogFields(error),
      });
    } else {
      logger.error('Unexpected error in turn event drain', {
        sessionId,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  } finally {
    executionDeadline.dispose();
  }
}

/** Inputs for drainTurnEvents, produced by beginTurnExecution. */
export interface TurnEventDrainInput {
  trackedStream: AsyncIterable<TurnStreamingEvent>;
  turnEventStream: EventSubscription<TurnStreamingEvent>;
  sessionId: string;
  turnId: string;
  executionDeadline: TurnExecutionDeadline;
  logger: Logger;
  turnDrains: TurnDrainRegistry;
  modelUsage: ModelUsageDrainMember;
  memory?: DrainTurnEventsInput['memory'];
}

/**
 * Shared create-turn engine: persist the turn, start execution, and return the
 * drain inputs. Does not wait for events and does not write HTTP/SSE.
 */
export async function beginTurnExecution(params: {
  session: SessionHandle<SessionCustom, TurnCustom>;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  userRef: string;
  deps: BeginTurnExecutionDeps;
  /** No person watches this turn (a scheduled run): what would ask is held for the owner. */
  unattended?: boolean | undefined;
}): Promise<{ turn: TurnHandle<TurnCustom>; drainInput: TurnEventDrainInput }> {
  const { session, input, previous_turn_id: previousTurnId, userRef, deps } = params;
  const sessionId = session.session_id;
  const turnId = mintPeeredTurnId(configuration.EXECUTOR_ID);

  const abortController = new AbortController();
  const executionDeadline = new TurnExecutionDeadline({
    abortController,
    default_timeout_ms: configuration.SERVER_EXECUTION_TIMEOUT_SECONDS * 1000,
    finalization_buffer_ms: 30_000,
  });
  const tenant_id = session.tenant_id;
  const modelUsage = new TurnModelUsageLedger({ prices: configuration.TOKEN_FACTORY_PRICES });
  // One read per turn: the persisted override (or env default) applies to the whole turn.
  const toolOutputScreenEnabled = await resolveToolOutputScreenEnabled({
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
  });
  // Same one-read-per-turn contract for turn summarization: resolved once here and shared
  // with the drain hook, so an off flag costs nothing and every non-running outcome is
  // logged instead of silently retaining verbatim.
  const memorySummarize = await resolveTurnSummarizeContext({
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
    sessionId,
    tenantId: tenant_id,
    modelProviderStore: deps.modelProviderStore,
    tokenFactoryBudget: deps.tokenFactoryBudget,
    modelUsage,
    agentStore: deps.agentStore,
    personaModelName: deps.personaContext?.model_name,
    sessionAgent: session.record.agent,
    memoryClientPresent: deps.memoryClient !== undefined,
    helperFqn: turnHelperModelFqn(),
  });
  // Same one-read-per-turn contract for the recall screen: the Settings toggle's
  // persisted override wins when stored, otherwise the MEMORY_SCREEN_ENABLED env default.
  const memoryScreenSetting = await readMemoryScreenSetting({
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
  });
  const effectiveMemorySettings = applyMemoryScreenOverride(
    deps.memorySettings,
    memoryScreenSetting.overridden ? memoryScreenSetting.enabled : undefined,
  );
  const internalSources = await resolveTurnInternalSources({
    session,
    previousTurnId,
    persona:
      deps.personaContext === undefined
        ? undefined
        : { id: deps.personaContext.persona_id, modelName: deps.personaContext.model_name },
    turnInput: input,
    knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
    modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
    modelProviderStore: deps.modelProviderStore,
    tokenFactoryBudget: deps.tokenFactoryBudget,
    modelUsage,
    helperFqn: turnHelperModelFqn(),
    logger: deps.logger,
  });
  const resolver = createTurnResolver({
    mcpCatalog: deps.mcpCatalog,
    mcpServerStore: deps.mcpServerStore,
    tokenStore: deps.tokenStore,
    skillStore: deps.skillStore,
    sandboxProviderStore: deps.sandboxProviderStore,
    sandboxProviderResolver: deps.sandboxProviderResolver ?? resolveSandboxProvider,
    agentStore: deps.agentStore,
    modelProviderStore: deps.modelProviderStore,
    repositoryStore: deps.repositoryStore,
    sessionStore: deps.sessionStore,
    spaceStore: deps.spaceStore,
    googleConnectionStore: deps.googleConnectionStore,
    logger: deps.logger,
    signal: abortController.signal,
    userRef,
    session,
    turnId,
    boundRepository: deps.boundRepository,
    serverSandboxAvailable: await readServerSandboxAvailable({
      store: deps.sandboxProviderStore,
      tenant_id: session.tenant_id,
      logger: deps.logger,
    }),
    personalizationProfile: deps.personalizationProfile,
    personaContext: deps.personaContext,
    personaKnowledgeBlock: internalSources.personaKnowledgeBlock,
    personaKnowledgeHits: internalSources.personaKnowledgeHits,
    internalSourceState: internalSources.internalSourceState,
    memoryClient: deps.memoryClient,
    memoryProviderServerName: deps.memoryProviderServerName,
    memorySettings: effectiveMemorySettings,
    previousTurnId: deps.previousTurnId ?? null,
    sessionTitle: deps.sessionTitle,
    clientTimezone: deps.clientTimezone,
    toolOutputScreenEnabled,
    turnArtifactStore: deps.turnArtifactStore,
    tokenFactoryBudget: deps.tokenFactoryBudget,
    modelUsage,
  });

  // First turn only: derive the title from the first user message. The store
  // never overwrites an existing title.
  const title = session.record.last_turn_id ? undefined : deriveSessionTitle(input);

  const turn = await session.createTurn({
    turn_id: turnId,
    input,
    previous_turn_id: previousTurnId,
    signal: abortController.signal,
    resolver,
    custom: { library_near_miss: internalSources.libraryNearMiss },
    update_session_title_if_not_exist: title,
    on_command_execution_started: execution => {
      executionDeadline.extendForRegisteredCommand(execution.timeout_ms);
    },
    command_execution_owner_id: configuration.EXECUTOR_ID,
    unattended: params.unattended,
  });

  executionDeadline.arm();

  const trackedStream = deps.activeTurns.track({
    sessionId,
    turnId: turn.id,
    abortController,
    stream: turn.stream(),
  });

  // Held for the whole turn; the stream's sequence counter dies with it.
  const turnEventStream = deps.eventSubscriptions.get(turnStreamId(tenant_id, sessionId, turn.id));

  return {
    turn,
    drainInput: {
      trackedStream,
      turnEventStream,
      sessionId,
      turnId: turn.id,
      executionDeadline,
      logger: deps.logger,
      turnDrains: deps.turnDrains,
      modelUsage: { ledger: modelUsage, eventStore: deps.sessionStore },
      memory:
        deps.memoryClient === undefined
          ? undefined
          : {
              client: deps.memoryClient,
              userText: extractUserMessageText(input ?? []),
              attachedFiles: inputAttachesFiles(input ?? []),
              sessionTitle: deps.sessionTitle,
              summarize: memorySummarize,
            },
    },
  };
}

/**
 * Non-stream create-turn: begin execution and resolve once the first event is
 * dual-written so immediate subscribe cannot 412. Same as `stream: false`.
 */
export async function startTurnInProcess(params: {
  session: SessionHandle<SessionCustom, TurnCustom>;
  input: TurnInputItem[] | undefined;
  previous_turn_id: string | undefined;
  userRef: string;
  deps: BeginTurnExecutionDeps;
  unattended?: boolean | undefined;
}): Promise<TurnHandle<TurnCustom>> {
  const { turn, drainInput } = await beginTurnExecution(params);

  // Same unawaited drain scheduling as Hono streamSSE's run(cb).
  const { promise: firstEventDualWritten, resolve: markFirstEventDualWritten } = Promise.withResolvers<undefined>();
  void drainTurnEvents({
    ...drainInput,
    onEvent: () => {
      markFirstEventDualWritten(undefined);
      return Promise.resolve();
    },
  }).finally(() => {
    markFirstEventDualWritten(undefined);
  });
  await firstEventDualWritten;
  return turn;
}

/** Mapped client error from turn execution; undefined means rethrow. */
export interface TurnExecutionError {
  status: 400 | 404 | 422;
  message: string;
}

/**
 * Resolve turn-start failures to HTTP status + message.
 * Returns undefined when the caller should rethrow (unexpected / 5xx).
 */
export function getTurnExecutionError(error: unknown): TurnExecutionError | undefined {
  if (error instanceof HTTPException) {
    if (error.status === 400 || error.status === 404 || error.status === 422) {
      return { status: error.status, message: error.message };
    }
    return undefined;
  }
  if (error instanceof SessionStoreNotFoundError) {
    return { status: 404, message: error.message };
  }
  if (error instanceof AgentHarnessError && !(error instanceof McpConnectionError)) {
    switch (error.code) {
      case 'invalid_file_input':
        return { status: 400, message: error.message };
      case 'invalid_send_input':
      case 'agent_sandbox_required':
      case 'tool_name_collision':
        return { status: 422, message: error.message };
      case 'capability_state_error':
      case 'mcp_connection_failed':
        return undefined;
    }
  }
  return undefined;
}

/**
 * Resume cursor: `Last-Event-ID` header wins over the body value because the
 * header is updated by the SDK on every reconnect to reflect the last delivered
 * event, whereas the body is the original caller-supplied cursor and never
 * changes between reconnect attempts.
 */
export function resolveAfterSequenceNumber(c: Context, bodyAfterSequenceNumber?: number): number | undefined {
  const lastEventId = c.req.header('last-event-id');
  if (lastEventId) {
    const sequenceNumber = Number(lastEventId);
    if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) {
      throw new HTTPException(400, { message: 'Invalid Last-Event-Id header' });
    }
    return sequenceNumber;
  }
  return bodyAfterSequenceNumber;
}

/** True when the subject is the session creator (`created_by_subject.subject_id`). */
function isSessionOwner({
  subject_id,
  created_by_subject,
}: {
  subject_id: string;
  created_by_subject: { subject_id: string };
}): boolean {
  return created_by_subject.subject_id === subject_id;
}

const FORBIDDEN_SESSION_ACCESS = 'Only the session creator can access this session';
const FORBIDDEN_CREATE_TURN = 'Only the session creator can create turns';

type RecordedApprovalResponse =
  | { status: 200; body: { data: Turn } }
  | { status: 409; body: { error: { message: string; type: 'conflict'; code: TurnConflictCode } } };

/**
 * Answers a resubmitted approval from stored state: the already-recorded turn when the same
 * decision is on record, a conflict when a different one is, or undefined when none is recorded.
 */
async function recordedApprovalResponse({
  session,
  previous_turn_id,
  input,
}: {
  session: SessionHandle<SessionCustom, TurnCustom>;
  previous_turn_id: string | undefined;
  input: TurnInputItem[] | undefined;
}): Promise<RecordedApprovalResponse | undefined> {
  const resubmission = await session.classifyApprovalResubmission({
    previous_turn_id,
    decisions: (input ?? []).filter(item => item.type === EventType.USER_TOOL_APPROVAL),
  });
  if (resubmission.outcome === 'replay') {
    return { status: 200, body: { data: toWireTurn(resubmission.turn) } };
  }
  if (resubmission.outcome === 'conflict') {
    return {
      status: 409,
      body: {
        error: {
          message: `Tool call ${resubmission.tool_call_id} already has a different decision on record`,
          type: 'conflict',
          code: TurnConflictCode.APPROVAL_CONFLICT,
        },
      },
    };
  }
  return undefined;
}

/** DB-backed turns (mounted at /api/v1/sessions). */
export function createTurnsRouter(deps: TurnsRouterDeps) {
  const listTurnsHandler: RouteHandler<typeof listTurnsRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: session.record.agent.type === 'reference' ? session.record.agent.id : undefined,
        created_by_subject_id: session.record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      const { data, pagination } = await session.listTurns({
        limit: query.limit,
        page_token: query.page_token,
      });
      const cleared = await session.clearedApprovalKeys();
      return c.json({ data: data.map(turn => toWireTurn(withoutClearedApprovals(turn, cleared))), pagination }, 200);
    } catch (error) {
      if (error instanceof SessionStoreConflictError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const listTurnArtifactsHandler: RouteHandler<typeof listTurnArtifactsRoute> = async c => {
    const { session_id: sessionId, turn_id: turnId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: session.record.agent.type === 'reference' ? session.record.agent.id : undefined,
        created_by_subject_id: session.record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const turn = await session.getTurn(turnId);
    if (!turn) {
      return c.json({ error: { message: `Turn not found: ${turnId}` } }, 404);
    }
    const rows = await deps.turnArtifactStore.listArtifacts({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
      turn_id: turnId,
    });
    return c.json(
      {
        data: rows.map(row => ({
          path: row.path,
          name: row.name,
          status: row.status,
          size: row.size,
          mime: row.mime,
          skip_reason: row.skip_reason,
          created_at: row.created_at,
        })),
      },
      200,
    );
  };

  const getTurnHandler: RouteHandler<typeof getTurnRoute> = async c => {
    const { session_id: sessionId, turn_id: turnId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: session.record.agent.type === 'reference' ? session.record.agent.id : undefined,
        created_by_subject_id: session.record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const turn = await session.getTurn(turnId);
    if (!turn) {
      return c.json({ error: { message: `Turn not found: ${turnId}` } }, 404);
    }
    const cleared = await session.clearedApprovalKeys();
    return c.json({ data: toWireTurn(withoutClearedApprovals(turn.record, cleared)) }, 200);
  };

  const downloadSandboxFileHandler: RouteHandler<typeof downloadSandboxFileRoute> = async c => {
    const { session_id: sessionId, turn_id: turnId } = c.req.valid('param');
    const { path } = c.req.valid('query');

    let sandboxId: string | undefined;
    try {
      // Cheapest first: a malformed path costs no store read and no provider round-trip.
      validateSandboxFilePath(path);

      const requestContext = deps.resolveRequestContext(c);
      const session = await deps.sessions.get({
        tenant_id: requestContext.tenant_id,
        session_id: sessionId,
      });
      if (!session) {
        return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
      }
      if (
        !isSessionOwner({
          subject_id: requestContext.subject.id,
          created_by_subject: session.record.created_by_subject,
        })
      ) {
        return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
      }

      // Loading the turn through the session is also a session-binding check: a turn id from another
      // session cannot be used to reach this session's sandbox.
      const turn = await session.getTurn(turnId);
      if (!turn) {
        return c.json({ error: { message: MISSING_REPLY_MESSAGE } }, 404);
      }

      // Persisted copy first: the sandbox that produced this file is likely long gone by the time
      // anyone clicks download (the provider auto-stops it minutes after the turn ends, then
      // deletes it later). Only a turn still running, or one that predates this feature, has no
      // row here, and those fall through to the live sandbox below, unchanged from before.
      const persisted = await findTurnArtifact({
        store: deps.turnArtifactStore,
        tenantId: requestContext.tenant_id,
        sessionId,
        turn: turn.record,
        path,
        getTurn: async previousTurnId => (await session.getTurn(previousTurnId))?.record,
      });
      if (persisted?.status === 'stored' && persisted.digest !== null) {
        const blob = await deps.turnArtifactStore.getBlob({
          tenant_id: requestContext.tenant_id,
          digest: persisted.digest,
        });
        if (blob !== undefined) {
          return c.body(toArrayBuffer(blob), 200, {
            'Content-Type': persisted.mime ?? 'application/octet-stream',
            'Content-Length': String(blob.byteLength),
            'Content-Disposition': toContentDisposition(path),
            'Cache-Control': 'private, no-store',
          });
        }
        // Index row says stored but the blob is gone (should not happen, logged, then treated
        // like "no persisted copy" so the live-sandbox fallback below gets a chance).
        deps.logger.error('turn_artifact row is stored but its blob is missing', {
          sessionId,
          turnId,
          path,
          digest: persisted.digest,
        });
      } else if (persisted?.status === 'skipped_size') {
        return c.json(
          { error: { message: `This file was not kept: ${persisted.skip_reason ?? 'it was too large to keep.'}` } },
          413,
        );
      }

      sandboxId = turn.record.snapshot.sandbox_info?.sandbox_id;
      if (sandboxId === undefined) {
        return c.json({ error: { message: CLEARED_WORKSPACE_MESSAGE } }, 412);
      }

      const provider = await (deps.sandboxProviderResolver ?? resolveSandboxProvider)({
        tenant_id: requestContext.tenant_id,
        store: deps.resolveSandboxProviderStore(c),
        logger: deps.logger,
        sessionId,
      });
      if (provider === undefined) {
        return c.json({ error: { message: NO_SANDBOX_MESSAGE } }, 412);
      }

      try {
        // TODO: stream the body instead of buffering the whole file in memory.
        const content = await provider.downloadFile({ sandboxId: rawSandboxId(sandboxId), path });
        return c.body(toArrayBuffer(content), 200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(content.byteLength),
          'Content-Disposition': toContentDisposition(path),
          'Cache-Control': 'private, no-store',
        });
      } catch (error) {
        // No persisted copy and the temporary workspace is gone: say what happened to this one file
        // instead of the raw provider error, which reads as if the whole chat had vanished.
        if (error instanceof SandboxNotAvailableError || error instanceof SandboxFileNotFoundError) {
          const reason =
            persisted?.status === 'skipped_missing'
              ? `This file was not kept: ${persisted.skip_reason ?? 'it was not found when this turn finished.'}`
              : CLEARED_WORKSPACE_MESSAGE;
          return c.json({ error: { message: reason } }, 410);
        }
        throw error;
      }
    } catch (error) {
      // Every guard and the provider itself raise SandboxError, whose statusCode is the contract.
      if (error instanceof SandboxError) {
        return c.json({ error: { message: error.message } }, error.statusCode);
      }
      deps.logger.error('Sandbox file download failed', {
        ...extractErrorLogFields(error),
        sessionId,
        turnId,
        sandboxId,
        path,
      });
      return c.json({ error: { message: 'Failed to download file from sandbox' } }, 424);
    }
  };

  const listTurnEventsHandler: RouteHandler<typeof listTurnEventsRoute> = async c => {
    const { session_id: sessionId, turn_id: turnId } = c.req.valid('param');
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: session.record.agent.type === 'reference' ? session.record.agent.id : undefined,
        created_by_subject_id: session.record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const turn = await session.getTurn(turnId);
    if (!turn) {
      return c.json({ error: { message: `Turn not found: ${turnId}` } }, 404);
    }
    try {
      const { data, pagination } = await turn.listEvents({
        limit: query.limit,
        page_token: query.page_token,
        order: query.order,
      });
      return c.json({ data, pagination }, 200);
    } catch (error) {
      if (error instanceof SessionStoreConflictError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const createAndExecuteTurnHandler: RouteHandler<typeof createAndExecuteTurnRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    const userRef = requestContext.subject.id;
    if (
      !isSessionOwner({
        subject_id: userRef,
        created_by_subject: session.record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_CREATE_TURN } }, 403);
    }

    // A card whose request ended is cleared, never run. Deny and Dismiss record that and answer with
    // the turn named, unchanged: no turn is created and no model is called. Approve is refused below.
    if (await session.answersOnlyEndedApprovals({ previous_turn_id: body.previous_turn_id, input: body.input })) {
      const decisions = body.input ?? [];
      if (decisions.every(item => item.type === EventType.USER_TOOL_APPROVAL && item.approval.status === 'deny')) {
        const named = await session.dismissEndedApprovals({
          previous_turn_id: body.previous_turn_id,
          input: body.input,
        });
        return c.json({ data: toWireTurn(named) }, 200);
      }
    }

    let referencedAgent: AgentRecord | undefined;
    const agentStore = deps.resolveAgentStore(c);
    if (session.record.agent.type === 'reference') {
      const agentId = session.record.agent.id;
      const agent = await agentStore.getAgent({
        tenant_id: requestContext.tenant_id,
        id: agentId,
      });
      if (agent === undefined) {
        return c.json({ error: { message: `Agent not found: ${agentId}` } }, 422);
      }
      const canUseAgent = await deps.authorizer.canAccessAgent({
        context: requestContext,
        action: 'use',
        agent,
      });
      if (!canUseAgent) {
        return c.json({ error: { message: `Agent not found: ${agentId}` } }, 404);
      }
      referencedAgent = agent;
    }

    const chatRunner: ChatRunner | undefined =
      referencedAgent !== undefined
        ? { kind: 'saved', agent: referencedAgent }
        : session.record.agent.type === 'inline'
          ? { kind: 'plain', spec: session.record.agent.spec }
          : undefined;
    const scheduleOwner = createdBySubjectFromRequestContext(requestContext);
    const modelProviderStore = deps.resolveModelProviderStore(c, referencedAgent);
    const mcpServerStore = deps.resolveMcpServerStore(c, referencedAgent);
    const skillStore = deps.resolveSkillStore(c);
    const sandboxProviderStore = deps.resolveSandboxProviderStore(c);

    let boundRepository: BoundRepository | undefined;
    try {
      boundRepository = await resolveBoundRepository({
        tenant_id: requestContext.tenant_id,
        created_by: userRef,
        repository_id: session.record.repository_id,
        workspace_cwd: session.record.workspace_cwd,
        store: deps.repositoryStore,
      });
    } catch (error) {
      if (error instanceof RepositoryBindingResolutionError) {
        return c.json({ error: { message: error.message } }, 422);
      }
      throw error;
    }

    const requestedParent = body.previous_turn_id;
    const previousTurnId =
      requestedParent === 'none' ? null : requestedParent === 'auto' ? session.record.last_turn_id : requestedParent;
    const previousTurn = previousTurnId === null ? undefined : await session.getTurn(previousTurnId);
    if (previousTurnId !== null && previousTurn === undefined) {
      return c.json({ error: { message: `Turn not found: ${previousTurnId}` } }, 404);
    }
    const profile = await deps.personalizationStore.getProfile({
      tenant_id: requestContext.tenant_id,
      created_by: userRef,
    });
    const previousTurnCustom = previousTurn?.custom;
    const latestManualActivation = await deps.personaStore.getLatestManualSessionPersona({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    const hasPersonaSnapshot =
      previousTurnCustom !== null && previousTurnCustom !== undefined && Object.hasOwn(previousTurnCustom, 'persona');
    const legacyParentActivation =
      !hasPersonaSnapshot && previousTurnId !== null
        ? await deps.personaStore.getTurnPersonaActivation({
            tenant_id: requestContext.tenant_id,
            session_id: sessionId,
            turn_id: previousTurnId,
          })
        : undefined;
    const latestManualActivationAfterParent =
      !hasPersonaSnapshot && previousTurnId !== null
        ? await deps.personaStore.getLatestManualSessionPersonaAfterTurn({
            tenant_id: requestContext.tenant_id,
            session_id: sessionId,
            turn_id: previousTurnId,
          })
        : undefined;

    // Resolved before the turn exists so an unavailable persona model is a
    // clean 422 rather than a turn that was created and then could not run.
    const persona = await resolveTurnPersona({
      personaStore: deps.personaStore,
      modelProviderStore,
      defaultAssistantName: profile?.assistant_name,
      tenant_id: requestContext.tenant_id,
      created_by: userRef,
      turnInput: body.input,
      previousTurnCustom,
      latestManualActivation,
      legacyParentActivation,
      latestManualActivationAfterParent,
    });
    const modelUsage = new TurnModelUsageLedger({ prices: configuration.TOKEN_FACTORY_PRICES });
    const internalSources = await resolveTurnInternalSources({
      session,
      previousTurnId,
      previousTurn,
      persona:
        persona?.kind === 'persona' ? { id: persona.persona.id, modelName: persona.persona.model_name } : undefined,
      turnInput: body.input,
      knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
      modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
      modelProviderStore,
      tokenFactoryBudget: deps.tokenFactoryBudget,
      modelUsage,
      helperFqn: turnHelperModelFqn(),
      logger: deps.logger,
    });
    const turnCustom: TurnCustom = {
      persona:
        persona === undefined || persona.kind === 'default'
          ? null
          : {
              persona_id: persona.persona.id,
              persona_name: persona.persona.display_name,
              model_name: persona.persona.model_name,
              source: persona.source,
            },
      manual_persona_activation_id: latestManualActivation?.id ?? null,
      library_near_miss: internalSources.libraryNearMiss,
    };

    // Resolved before the turn exists, same as the model/sandbox lookups above: a missing or
    // invalid memory provider must never fail the turn, so this degrades to `undefined` rather
    // than throwing. Read once and shared between the resolver (recall) and the drain hook
    // (retain) so a turn dials the provider through a single client instance. The markdown
    // backend needs no MCP server, so the provider lookup is skipped unless hindsight is
    // selected.
    const memoryProvider =
      configuration.MEMORY_BACKEND === 'hindsight'
        ? await resolveMemoryProvider({
            mcpServerStore,
            tokenStore: deps.tokenStore,
            tenantId: requestContext.tenant_id,
            clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
            userRef,
            logger: deps.logger,
          })
        : undefined;
    const vaultScope =
      persona?.kind === 'persona'
        ? { personaName: persona.persona.display_name, personaId: persona.persona.id }
        : undefined;
    // The previous turn's retain lives in the vault that turn ran under. Verifying or recovering
    // it through another vault's client would copy that exchange across vaults, so only a turn
    // in the same vault hands its id to memory.
    const previousTurnPersonaName =
      previousTurnCustom?.persona?.persona_name ?? legacyParentActivation?.persona_name ?? null;
    const memoryPreviousTurnId = previousTurnPersonaName === (vaultScope?.personaName ?? null) ? previousTurnId : null;
    const memoryClient = createMemoryClient({
      backend: configuration.MEMORY_BACKEND,
      markdownDir: configuration.MEMORY_MARKDOWN_DIR,
      namespace: requestContext.tenant_id,
      vaultScope,
      hindsight:
        memoryProvider === undefined
          ? undefined
          : {
              apiBase: memoryProvider.apiBase,
              bank: memoryProvider.bank,
              headers: memoryProvider.headers,
            },
      // Meaning-based recall: the subsystem singleton loads the model once per
      // process and degrades to keyword-only until it is ready, so a missing or
      // slow model download never fails or slows the turn.
      embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
        ? {
            modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
            batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
            log: (message: string) => deps.logger.info(message),
          }
        : undefined,
    });
    // The title comes from the session's first message, so it may only ride along in the vault
    // that first turn ran under; in any other vault it would carry that turn's text across.
    const firstTurn =
      session.record.last_turn_id === null ? undefined : (await session.listTurns({ limit: 1 })).data[0];
    const titleSharesVault =
      session.record.last_turn_id === null ||
      (firstTurn !== undefined &&
        (firstTurn.custom?.persona?.persona_name ?? null) === (vaultScope?.personaName ?? null));
    const sessionTitleForMemory = chatTitleContext({
      title: titleSharesVault ? (session.record.title ?? deriveSessionTitle(body.input)) : undefined,
      assistantNames: [
        profile?.assistant_name,
        ...(await deps.personaStore.listPersonas({ tenant_id: requestContext.tenant_id, created_by: userRef })).flatMap(
          candidate => [candidate.display_name, ...candidate.aliases],
        ),
      ],
    });

    // Resolved before the turn exists, like the memory provider above: the pass itself runs
    // after TURN_DONE (awaited by the tracked drain) and every failure inside it silently
    // no-ops. Read off the
    // profile already loaded for the personalization context, so learning left off (the default)
    // costs nothing here, not even the model-FQN lookup. The pass re-reads the switch itself, so
    // a user who turns it off mid-turn is still obeyed.
    //
    // This is the one part of the pass that runs on the create-turn path, so it is the one
    // part that could fail a turn. It must not: an agent-store read that throws drops learning
    // for this turn and nothing more.
    let profileLearning: ProfileLearningDrainMember | undefined;
    if (profile?.learning_enabled === true) {
      try {
        profileLearning = {
          config: profileLearningPassConfig(),
          personalizationStore: deps.personalizationStore,
          eventStore: deps.sessionStore,
          modelProviderStore,
          tokenFactoryBudget: deps.tokenFactoryBudget,
          modelUsage,
          memoryClient,
          tenantId: requestContext.tenant_id,
          createdBy: userRef,
          userText: extractUserMessageText(body.input),
          helperFqn: turnHelperModelFqn(),
          turnModelFqn: await resolveTurnModelFqn({
            tenantId: requestContext.tenant_id,
            personaModelName: persona?.kind === 'persona' ? persona.persona.model_name : undefined,
            sessionAgent: session.record.agent,
            agentStore,
          }),
        };
      } catch (error) {
        deps.logger.debug('Profile learning disabled for this turn: the model FQN did not resolve', {
          sessionId,
          ...extractErrorLogFields(error),
        });
        profileLearning = undefined;
      }
    }

    // One read per turn: the Settings toggle's persisted override wins when stored, otherwise
    // the MEMORY_SUMMARIZE env default. Resolved before the turn exists, next to the profile
    // learning lookup above, so the drain hook below can summarize without a store of its own.
    const memorySummarize = await resolveTurnSummarizeContext({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
      sessionId,
      tenantId: requestContext.tenant_id,
      modelProviderStore,
      tokenFactoryBudget: deps.tokenFactoryBudget,
      modelUsage,
      agentStore,
      personaModelName: persona?.kind === 'persona' ? persona.persona.model_name : undefined,
      sessionAgent: session.record.agent,
      memoryClientPresent: memoryClient !== undefined,
      helperFqn: turnHelperModelFqn(),
    });

    const abortController = new AbortController();
    const executionDeadline = new TurnExecutionDeadline({
      abortController,
      default_timeout_ms: configuration.SERVER_EXECUTION_TIMEOUT_SECONDS * 1000,
      finalization_buffer_ms: 30_000,
    });
    const turnId = mintPeeredTurnId(configuration.EXECUTOR_ID);
    // One read per turn: the persisted override (or env default) applies to the whole turn.
    const toolOutputScreenEnabled = await resolveToolOutputScreenEnabled({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    // Same one-read-per-turn contract for the recall screen.
    const memoryScreenSetting = await readMemoryScreenSetting({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    const effectiveMemorySettings = applyMemoryScreenOverride(
      memoryProvider?.settings,
      memoryScreenSetting.overridden ? memoryScreenSetting.enabled : undefined,
    );
    const resolver = createTurnResolver({
      mcpCatalog: deps.mcpCatalog,
      mcpServerStore,
      tokenStore: deps.tokenStore,
      skillStore,
      sandboxProviderStore,
      sandboxProviderResolver: deps.sandboxProviderResolver ?? resolveSandboxProvider,
      agentStore,
      modelProviderStore,
      logger: deps.logger,
      signal: abortController.signal,
      userRef,
      session,
      turnId,
      personalizationProfile: profile,
      personaContext: persona?.kind === 'persona' ? persona.context : undefined,
      personaKnowledgeBlock: internalSources.personaKnowledgeBlock,
      personaKnowledgeHits: internalSources.personaKnowledgeHits,
      switchNotice: persona?.switchNotice,
      internalSourceState: internalSources.internalSourceState,
      boundRepository,
      serverSandboxAvailable: await readServerSandboxAvailable({
        store: sandboxProviderStore,
        tenant_id: requestContext.tenant_id,
        logger: deps.logger,
      }),
      repositoryStore: deps.repositoryStore,
      sessionStore: deps.sessionStore,
      memoryClient,
      memoryProviderServerName: memoryProvider?.serverName,
      memorySettings: effectiveMemorySettings,
      previousTurnId: memoryPreviousTurnId,
      sessionTitle: sessionTitleForMemory,
      spaceStore: deps.spaceStore,
      googleConnectionStore: deps.googleConnectionStore,
      clientTimezone: body.client_timezone,
      toolOutputScreenEnabled,
      turnArtifactStore: deps.turnArtifactStore,
      tokenFactoryBudget: deps.tokenFactoryBudget,
      modelUsage,
      personas:
        chatRunner === undefined
          ? undefined
          : {
              store: deps.personaStore,
              modelProviderStore,
              tenant_id: requestContext.tenant_id,
              owner_id: userRef,
              model_name: chatModelName(chatRunner),
              session_id: session.session_id,
              logger: deps.logger,
            },
      schedules:
        deps.schedules === undefined || chatRunner === undefined
          ? undefined
          : {
              ...deps.schedules,
              tenant_id: requestContext.tenant_id,
              owner: scheduleOwner,
              // A schedule made here runs as whatever runs this turn: the chat's agent or setup, and its persona.
              chatAssistant: resolveChatAssistant({
                tenant_id: requestContext.tenant_id,
                owner: scheduleOwner,
                runner: chatRunner,
                persona: persona?.kind === 'persona' ? persona.persona : undefined,
                assistantName: profile?.assistant_name ?? null,
                agentStore,
              }),
              runsAs: scheduleRunsAs({
                tenant_id: requestContext.tenant_id,
                agentStore,
                personaStore: deps.personaStore,
                personalizationStore: deps.personalizationStore,
              }),
              logger: deps.logger,
            },
    });

    // First turn only: derive the title from the first user message. The store
    // never overwrites an existing title.
    const title = session.record.last_turn_id ? undefined : deriveSessionTitle(body.input);

    // Turning down held actions ends the turn with no model call. Approving one runs the call,
    // and the model continues with its result.
    const stopAfterToolResponse = await session.answersOnlyDeniedHeldActions({
      previous_turn_id: body.previous_turn_id,
      input: body.input,
    });

    let turn;
    try {
      turn = await session.createTurn({
        turn_id: turnId,
        input: body.input,
        previous_turn_id: body.previous_turn_id,
        signal: abortController.signal,
        resolver,
        custom: turnCustom,
        update_session_title_if_not_exist: title,
        on_command_execution_started: execution => {
          executionDeadline.extendForRegisteredCommand(execution.timeout_ms);
        },
        command_execution_owner_id: configuration.EXECUTOR_ID,
        stop_after_tool_response: stopAfterToolResponse,
      });
    } catch (error) {
      if (error instanceof SessionStoreNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof SessionStoreConflictError) {
        if (error instanceof StaleApprovalContinuationError) {
          // The tip moved after this request read the session. A double submit or a second tab
          // may already have recorded this exact decision; the handle read above is stale, so
          // classify against a fresh one. A replay never runs the tool again.
          const freshSession = await deps.sessions.get({
            tenant_id: requestContext.tenant_id,
            session_id: sessionId,
          });
          if (freshSession !== undefined) {
            const response = await recordedApprovalResponse({
              session: freshSession,
              previous_turn_id: body.previous_turn_id,
              input: body.input,
            });
            if (response !== undefined) {
              return c.json(response.body, response.status);
            }
          }
        }
        return c.json({ error: { message: error.message, type: 'conflict', code: turnConflictCodeFor(error) } }, 409);
      }
      if (error instanceof AgentHarnessError && !(error instanceof McpConnectionError)) {
        switch (error.code) {
          case 'invalid_file_input':
            return c.json({ error: { message: error.message } }, 400);
          case 'invalid_send_input': {
            // A held action that cannot run is a conflict with what is stored, and says why by code.
            if (error instanceof HeldActionRefusedError) {
              return c.json(
                {
                  error: {
                    message: error.message,
                    type: 'conflict',
                    code: `held_action_${error.reason}` satisfies HeldActionConflictCode,
                  },
                },
                409,
              );
            }
            // A decision the session already recorded is a resubmission, not a bad request:
            // the tool has run (or been denied) once and must not run again. Answer from
            // stored state; only a genuinely unrecorded decision keeps the 422.
            const response = await recordedApprovalResponse({
              session,
              previous_turn_id: body.previous_turn_id,
              input: body.input,
            });
            if (response !== undefined) {
              return c.json(response.body, response.status);
            }
            return c.json({ error: { message: error.message } }, 422);
          }
          case 'agent_sandbox_required':
          case 'tool_name_collision':
            return c.json({ error: { message: error.message } }, 422);
          case 'capability_state_error':
          case 'mcp_connection_failed':
            throw error;
        }
      }
      throw error;
    }

    /**
     * A turn is durable and `running` after createTurn, but inference has not
     * started yet on these paths. Always make it terminal before returning an
     * error so the chat never retains a turn that no executor owns.
     */
    const abandonUnstartedTurn = async (context: string, cause?: unknown): Promise<void> => {
      abortController.abort(CancellationReason.Abandoned);
      turn.forgetUnstarted();
      await resolver.close().catch((closeError: unknown) => {
        deps.logger.error(`Failed to close turn resources after ${context}`, {
          sessionId,
          turnId: turn.id,
          ...extractErrorLogFields(closeError),
        });
      });

      const freezeFailures: unknown[] = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          // Freezing is idempotent: a response can be lost after the store
          // committed, and retrying returns the existing terminal turn.
          await session.freezeTurn({ turn_id: turn.id, reason: CancellationReason.Abandoned });
          return;
        } catch (freezeError) {
          freezeFailures.push(freezeError);
          deps.logger.error(`Failed to end the turn after ${context}`, {
            sessionId,
            turnId: turn.id,
            attempt,
            ...extractErrorLogFields(freezeError),
          });
        }
      }
      throw new AggregateError(
        cause === undefined ? freezeFailures : [cause, ...freezeFailures],
        `${context}; the durable running turn could not be ended`,
        cause === undefined ? undefined : { cause },
      );
    };

    // Chats without persona provenance still recheck the manual selection
    // observed during resolution. Persona-backed turns perform this comparison
    // atomically with their provenance insert below, so a UI choice cannot land
    // between validation and the write that would otherwise supersede it.
    if (persona === undefined) {
      let manualSelectionStillCurrent: boolean;
      try {
        manualSelectionStillCurrent = await deps.personaStore.isManualSessionPersonaCurrent({
          tenant_id: requestContext.tenant_id,
          session_id: sessionId,
          expected_activation_id: latestManualActivation?.id ?? null,
        });
      } catch (error) {
        await abandonUnstartedTurn('persona admission validation failed', error);
        throw error;
      }
      if (!manualSelectionStillCurrent) {
        await abandonUnstartedTurn('persona selection changed during admission');
        return c.json(
          {
            error: {
              message:
                'Persona selection changed while this turn was being admitted. The turn was not started; submit it again.',
              type: 'conflict',
            },
          },
          409,
        );
      }
    }

    if (persona?.kind === 'persona') {
      let personaStillCurrent: boolean;
      try {
        personaStillCurrent = await isTurnPersonaResolutionCurrent({
          resolution: persona,
          personaStore: deps.personaStore,
          tenant_id: requestContext.tenant_id,
          created_by: userRef,
        });
      } catch (error) {
        await abandonUnstartedTurn('persona revision validation failed', error);
        throw error;
      }
      if (!personaStillCurrent) {
        await abandonUnstartedTurn('persona changed during admission');
        return c.json(
          {
            error: {
              message:
                'The selected persona changed while this turn was being admitted. The turn was not started; submit it again.',
              type: 'conflict',
            },
          },
          409,
        );
      }
    }

    // Written after the turn commits, so the log never claims a persona
    // answered a turn that was never created. For semantic and sticky choices,
    // the expected manual activation is compared and the provenance is written
    // under one session lock. A deterministic direct invocation keeps its
    // documented precedence over a concurrent UI choice.
    if (persona !== undefined) {
      let activationRecorded: boolean;
      try {
        const activation = {
          tenant_id: requestContext.tenant_id,
          id: ulid().toLowerCase(),
          session_id: sessionId,
          turn_id: turn.id,
          persona_id: persona.kind === 'persona' ? persona.persona.id : null,
          persona_name: persona.kind === 'persona' ? persona.persona.display_name : null,
          model_name: persona.kind === 'persona' ? persona.persona.model_name : null,
          source: persona.source,
        };
        // A no-op switch (the invocation named the already-active identity, or an ambiguous
        // request failed closed onto the already-active default) changes no state, so the
        // activation log records nothing while the turn still runs under that identity.
        if (persona.skipActivationWrite === true) {
          activationRecorded = true;
        } else if (persona.selection === 'direct') {
          await deps.personaStore.recordPersonaActivation(activation);
          activationRecorded = true;
        } else {
          activationRecorded =
            (await deps.personaStore.recordPersonaActivationIfManualCurrent({
              ...activation,
              expected_activation_id: latestManualActivation?.id ?? null,
            })) !== undefined;
        }
      } catch (error) {
        // The turn is durable and `running` by now, and nothing has begun
        // draining it: the generator that would write its terminal state has
        // not been started and never will be on this path. Reporting the
        // failure without ending it would leave the chat holding a turn no
        // runner owns. So the request still fails, but it fails with the turn
        // in a terminal state and the session able to take its next one.
        deps.logger.error('Persona provenance write failed; ending the turn it belongs to', {
          sessionId,
          turnId: turn.id,
          personaId: persona.kind === 'persona' ? persona.persona.id : null,
          ...extractErrorLogFields(error),
        });
        await abandonUnstartedTurn('persona provenance write failed', error);
        throw error;
      }
      if (!activationRecorded) {
        await abandonUnstartedTurn('persona selection changed during admission');
        return c.json(
          {
            error: {
              message:
                'Persona selection changed while this turn was being admitted. The turn was not started; submit it again.',
              type: 'conflict',
            },
          },
          409,
        );
      }
    }

    executionDeadline.arm();

    const trackedStream = deps.activeTurns.track({
      sessionId,
      turnId: turn.id,
      abortController,
      stream: turn.stream(),
    });

    // Held for the whole turn; the stream's sequence counter dies with it.
    const turnEventStream = deps.eventSubscriptions.get(turnStreamId(requestContext.tenant_id, sessionId, turn.id));
    const drainInput = {
      trackedStream,
      turnEventStream,
      sessionId,
      turnId: turn.id,
      executionDeadline,
      logger: deps.logger,
      turnDrains: deps.turnDrains,
      modelUsage: { ledger: modelUsage, eventStore: deps.sessionStore },
      memory:
        memoryClient === undefined
          ? undefined
          : {
              client: memoryClient,
              userText: extractUserMessageText(body.input),
              attachedFiles: inputAttachesFiles(body.input ?? []),
              sessionTitle: sessionTitleForMemory,
              // Resolved once on the create-turn path above; absent means verbatim.
              summarize: memorySummarize,
              outcomeLog: {
                personaName: vaultScope?.personaName ?? 'shared',
                personaStore: deps.personaStore,
                tenantId: requestContext.tenant_id,
              },
            },
      profileLearning,
      artifacts: {
        turnArtifactStore: deps.turnArtifactStore,
        sandboxProviderStore,
        sandboxProviderResolver: deps.sandboxProviderResolver ?? resolveSandboxProvider,
        sessions: deps.sessions,
        tenantId: requestContext.tenant_id,
      },
    };

    // Non-stream: same unawaited drain scheduling as Hono streamSSE's run(cb).
    // Wait until the first dual-write (turn.created) so immediate subscribeToTurn
    // cannot 412 before the resumable stream exists.
    if (!body.stream) {
      const { promise: firstEventDualWritten, resolve: markFirstEventDualWritten } = Promise.withResolvers<undefined>();
      void drainTurnEvents({
        ...drainInput,
        onEvent: () => {
          markFirstEventDualWritten(undefined);
          return Promise.resolve();
        },
      }).finally(() => {
        markFirstEventDualWritten(undefined);
      });
      await firstEventDualWritten;
      return c.json({ data: toWireTurn(turn.record) }, 200);
    }

    let shouldWriteToSSEStream = true;
    return streamSSE(c, async stream => {
      stream.onAbort(() => {
        shouldWriteToSSEStream = false;
      });
      await drainTurnEvents({
        ...drainInput,
        onEvent: async (event, sequenceNumber) => {
          if (!stream.closed && !stream.aborted && shouldWriteToSSEStream) {
            try {
              await stream.writeSSE(turnEventSsePayload(event, sequenceNumber));
            } catch (error) {
              deps.logger.error('SSE stream write error', extractErrorLogFields(error));
              shouldWriteToSSEStream = false;
            }
          }
        },
      });
      await stream.close();
    });
  };

  const subscribeTurnHandler: RouteHandler<typeof subscribeTurnRoute> = async c => {
    const { session_id: sessionId, turn_id: turnId } = c.req.valid('param');
    const query = c.req.valid('query');
    const afterSequenceNumber = resolveAfterSequenceNumber(c, query.after_sequence_number);
    const requestContext = deps.resolveRequestContext(c);

    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: session.record.agent.type === 'reference' ? session.record.agent.id : undefined,
        created_by_subject_id: session.record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const turn = await session.getTurn(turnId);
    if (!turn) {
      return c.json({ error: { message: `Turn not found: ${turnId}` } }, 404);
    }

    const turnEventStream = deps.eventSubscriptions.get(turnStreamId(requestContext.tenant_id, sessionId, turnId));

    // Admission check before SSE headers are sent, so it can still map to HTTP 412.
    try {
      await turnEventStream.assertSubscribable();
    } catch (error) {
      if (error instanceof StreamGoneError) {
        throw new HTTPException(412, { message: error.message, cause: error });
      }
      throw error;
    }

    // One lifecycle controller: server-side timeout, client disconnect, and
    // normal teardown all abort it, which ends poll even while it is parked
    // waiting for events.
    const subscribeAbort = new AbortController();
    const timeoutMs = configuration.TURN_SUBSCRIBE_TIMEOUT_MS;
    const timeoutHandler = setTimeout(() => {
      deps.logger.info('Subscribe turn stream server-side timeout reached, closing stream', {
        sessionId,
        turnId,
        afterSequenceNumber,
        timeoutMs,
      });
      subscribeAbort.abort(new Error('subscribe-timeout'));
    }, timeoutMs);

    return streamSSE(c, async stream => {
      stream.onAbort(() => {
        subscribeAbort.abort(new Error('client-disconnected'));
      });

      const generator = turnEventStream.poll(afterSequenceNumber, { signal: subscribeAbort.signal });
      try {
        for await (const { sequence_number: sequenceNumber, ...event } of generator) {
          await stream.writeSSE(turnEventSsePayload(event, sequenceNumber));
          if (event.type === EventType.TURN_DONE) {
            break;
          }
        }
      } catch (error) {
        if (!subscribeAbort.signal.aborted) {
          deps.logger.error('Unexpected error in turn subscribe SSE loop', extractErrorLogFields(error));
        }
      } finally {
        clearTimeout(timeoutHandler);
        // Poll loops forever by design; aborting releases a parked generator
        // immediately so the return() below settles right away.
        subscribeAbort.abort();
        await generator.return(undefined);
        await stream.close();
      }
    });
  };

  const router = new OpenAPIHono();
  router.openapi(createAndExecuteTurnRoute, createAndExecuteTurnHandler);
  router.openapi(listTurnsRoute, listTurnsHandler);
  router.openapi(getTurnRoute, getTurnHandler);
  router.openapi(downloadSandboxFileRoute, downloadSandboxFileHandler);
  router.openapi(listTurnArtifactsRoute, listTurnArtifactsHandler);
  router.openapi(listTurnEventsRoute, listTurnEventsHandler);
  router.openapi(subscribeTurnRoute, subscribeTurnHandler);
  return router;
}
