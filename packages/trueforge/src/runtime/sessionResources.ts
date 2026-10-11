import type { AgentSpec, SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import type { SentinelHostContext } from '@truefoundry/trueforge-core/core';
import {
  DockerDriver,
  McpConnectionError,
  RunCodeService,
  Sandbox,
  SkillMounter,
  type AgentTracing,
  type BoundRepository,
  type GitSkill,
  type ModelParams,
  type RemoteMcpHeaders,
  type RepositoryCommandSourceObserver,
  type SandboxProvider,
  type SkillPromptMode,
  type VercelAILLMConfig,
  type VercelAIProviderConfig,
  type WorkspaceVerificationCoordinator,
} from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import { join } from 'node:path';
import type { Logger } from 'winston';
import configuration, { type TokenFactoryMode } from '../config';
import type { IMcpServerStore, IMcpServerWithAuthStore, McpServerRecord } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IRepositoryStore } from '../db/repositoryStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISkillStore } from '../db/skillStore';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import { isMcpAuthRequired, resolveMcpAuth } from '../mcp/auth/mcpDcr';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { isFirstPartyOrigin } from '../mcp/firstParty';
import { LocalSandboxProvider } from '../sandbox/local/provider/LocalSandboxProvider';
import { getCachedLocalSandboxSupport, isLocalSandboxFallbackEnabled } from '../sandbox/localRuntime';
import { toSandboxProviderFromRecord } from '../sandbox/providerUtils';
import { resolveConfiguredMcpRequestHeaders, type McpServerManifest } from '../schemas/mcpServer';
import type { ModelProperties, ModelProviderStreamTimeout } from '../schemas/modelProvider';
import { parseGitSkill } from '../schemas/skill';
import { isSecretReference, resolveSecretReference } from '../utils/secretReferences';
import { buildRunCodeHarvestSink } from './artifacts/persistRunCodeHarvests';

export interface McpConnection {
  url: string;
  headers: RemoteMcpHeaders;
  /** The stored connector's trust marker, and only while the operator still lists its origin. */
  first_party: boolean;
}

const GITHUB_MCP_SERVER_NAME = 'github';
const TRUSTED_GITHUB_MCP_HOSTS = new Set(['api.githubcopilot.com', 'api.github.com']);

/**
 * Known MCP connector names that expose web search/fetch tools. A session
 * with one of these attached should route page reads through the connector
 * rather than an exec-tool `curl`/`wget` — see {@link isWebConnectorAttached}.
 */
const WEB_MCP_SERVER_NAMES = new Set(['parallel-web', 'web-search', 'web']);

export class RepositoryBindingResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryBindingResolutionError';
  }
}

/**
 * Resolve one persisted session binding into the host-owned sandbox contract.
 * Proposed commands never enter this path; only explicitly confirmed registry
 * rows can be exposed to or executed by the model.
 */
export async function resolveBoundRepository(input: {
  tenant_id: string;
  created_by: string;
  repository_id: string | null;
  workspace_cwd: string | null;
  store: Pick<IRepositoryStore, 'getRepository' | 'listVerifyCommands'>;
}): Promise<BoundRepository | undefined> {
  if (input.repository_id === null && input.workspace_cwd === null) {
    return undefined;
  }
  if (input.repository_id === null || input.workspace_cwd === null) {
    throw new RepositoryBindingResolutionError(
      'The session repository binding is incomplete. Rebind the chat to a repository and absolute workspace cwd.',
    );
  }
  const owner = {
    tenant_id: input.tenant_id,
    created_by: input.created_by,
    repository_id: input.repository_id,
  };
  const repository = await input.store.getRepository(owner);
  if (repository === undefined) {
    throw new RepositoryBindingResolutionError(
      `Repository binding ${input.repository_id} is unavailable for this user. Rebind the chat to an accessible repository.`,
    );
  }
  const commands = await input.store.listVerifyCommands(owner);
  return {
    repository_id: repository.id,
    revision: repository.revision,
    workspace_cwd: input.workspace_cwd,
    commands: commands.map(command => ({
      command_id: command.command_id,
      purpose: command.purpose,
      command: command.command,
      timeout_ms: command.timeout_ms,
    })),
  };
}

/**
 * Whether the agent spec has a GitHub MCP connector configured, regardless of
 * whether {@link resolveGithubGitToken} could resolve usable
 * credentials from it. Used to distinguish "no connector attached" from
 * "connector attached but credentials were refused" in sandbox remediation.
 */
export function isGithubConnectorAttached(spec: AgentSpec): boolean {
  return (spec.mcp_servers ?? []).some(server => server.name === GITHUB_MCP_SERVER_NAME);
}

/**
 * Whether the agent spec has a web search/fetch MCP connector configured.
 * Used to route the sandbox exec tool's `curl`/`wget` egress rejection to the
 * connector's own fetch/extract tool instead of leaving raw network access
 * to an exec command.
 */
export function isWebConnectorAttached(spec: AgentSpec): boolean {
  return (spec.mcp_servers ?? []).some(server => WEB_MCP_SERVER_NAMES.has(server.name));
}

/**
 * Resolve the configured GitHub connector PAT for host-authenticated git.
 *
 * The credential is admitted only when the agent explicitly enables the GitHub
 * connector and that connector points at a GitHub-owned host. The token stays on
 * the host: {@link Sandbox} injects it into the environment of a single
 * validated network git process and never writes it to the sandbox.
 */
export async function resolveGithubGitToken({
  tenant_id,
  spec,
  store,
}: {
  tenant_id: string;
  spec: AgentSpec;
  store: IMcpServerStore;
}): Promise<string | null> {
  if (!isGithubConnectorAttached(spec)) {
    return null;
  }
  const record = await store.getServer({ tenant_id, name: GITHUB_MCP_SERVER_NAME });
  if (record?.manifest.auth?.type !== 'header') {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(record.manifest.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!TRUSTED_GITHUB_MCP_HOSTS.has(hostname)) {
    return null;
  }
  const authorization = Object.entries(record.manifest.auth.headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1];
  const bearerToken = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const rawToken = authorization?.match(/^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+$/)?.[0];
  const token = bearerToken ?? rawToken;
  if (token === undefined) {
    return null;
  }
  return token;
}

/** Gateway header carrying stringified JSON metadata. */
export const X_TFY_METADATA = 'x-tfy-metadata';

/** Prefix for harness-owned keys */
export const TFG_METADATA_PREFIX = 'tfg';

export function buildGatewayMetadata<TSessionCustom extends object, TTurnCustom extends object>(input: {
  session: SessionHandle<TSessionCustom, TTurnCustom>;
  turnId: string;
}): Record<string, string> {
  // Session.metadata is intentionally omitted for now (Unicode-in-header risk); re-add later.
  const metadata: Record<string, string> = {
    [`${TFG_METADATA_PREFIX}.session_id`]: input.session.session_id,
    [`${TFG_METADATA_PREFIX}.turn_id`]: input.turnId,
  };
  const { agent } = input.session;
  if (agent.type === 'reference') {
    metadata[`${TFG_METADATA_PREFIX}.agent_id`] = agent.id;
    if (agent.name !== null) {
      metadata[`${TFG_METADATA_PREFIX}.agent_name`] = agent.name;
    }
  }
  return metadata;
}

export function gatewayMetadataHeaders(metadata: Record<string, string>): Record<string, string> {
  if (Object.keys(metadata).length === 0) {
    return {};
  }
  return { [X_TFY_METADATA]: JSON.stringify(metadata) };
}

/**
 * Merge gateway metadata into MCP invoke headers. Preserves authRequired;
 * metadata is applied after auth/per-server headers.
 */
export function withGatewayMetadataHeaders(input: {
  headers: RemoteMcpHeaders;
  metadataHeaders: Record<string, string>;
}): RemoteMcpHeaders {
  const { headers, metadataHeaders } = input;
  if (Object.keys(metadataHeaders).length === 0) {
    return headers;
  }
  if (typeof headers !== 'function') {
    return { ...headers, ...metadataHeaders };
  }
  return async () => {
    const result = await headers();
    if ('authRequired' in result) {
      return result;
    }
    return { headers: { ...result.headers, ...metadataHeaders } };
  };
}

/** Split `provider/model` FQN. Returns undefined when the shape is not exactly one slash. */
export function parseModelFqn(name: string): { providerName: string; modelName: string } | undefined {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) {
    return undefined;
  }
  if (name.includes('/', slash + 1)) {
    return undefined;
  }
  return { providerName: name.slice(0, slash), modelName: name.slice(slash + 1) };
}

/**
 * Load turn-ready model config and defaults for a configured FQN (`provider/model`).
 * Malformed FQN or missing provider/model → HTTPException(422).
 */

export async function getModelDetails({
  tenant_id,
  name,
  store,
}: {
  tenant_id: string;
  name: string;
  store: IModelProviderStore;
}): Promise<{
  providerConfig: VercelAIProviderConfig;
  defaultModelParams: ModelParams;
  modelProperties: ModelProperties;
  /** Provider-level override of the server-wide stream progress deadlines, if configured. */
  streamTimeout: VercelAILLMConfig['streamTimeout'];
}> {
  const parsed = parseModelFqn(name);
  if (parsed === undefined) {
    throw new HTTPException(422, {
      message: `Model name must be a fully qualified "provider/model": ${name}`,
    });
  }
  const provider = await store.getProvider({
    tenant_id,
    name: parsed.providerName,
    model_name: parsed.modelName,
  });
  if (provider === undefined) {
    throw new HTTPException(422, {
      message: `Unknown model "${name}" — provider not configured`,
    });
  }
  const model = provider.manifest.models.find(entry => entry.name === parsed.modelName);
  if (model === undefined) {
    throw new HTTPException(422, {
      message: `Unknown model "${name}" — not configured on provider`,
    });
  }
  // Provider types are adapter names, so this assignment is what keeps them so: a type with no
  // `buildLanguageModel` case fails to compile here.
  const { type, base_url: baseUrl, stream_timeout } = provider.manifest;
  return {
    providerConfig: {
      provider: { type, name: provider.name },
      model: { id: model.model_id, name: model.name },
      name,
      baseUrl,
      apiKey: provider.manifest.auth?.api_key ?? '',
      headers: {},
    },
    defaultModelParams: model.properties.max_output_tokens ? { max_tokens: model.properties.max_output_tokens } : {},
    modelProperties: model.properties,
    streamTimeout: modelProviderStreamTimeout(stream_timeout),
  };
}

/**
 * Applies Nebius Token Factory routing to an already-resolved primary provider config.
 *
 * `fallback` keeps the configured provider first and uses Token Factory when it fails
 * before producing output; `force` routes to Token Factory first (for testing and demo
 * paths) with the configured provider as fallback. Routing is inactive when the mode is
 * `off`, when no API key is configured, or when the primary already is Token Factory.
 * Failover itself happens inside `VercelAILLM` and only before any output is produced.
 */
export function applyTokenFactoryRouting(input: {
  primary: VercelAIProviderConfig;
  mode: TokenFactoryMode;
  apiKey: string | undefined;
  model: string;
  baseUrl: string;
}): {
  providerConfig: VercelAIProviderConfig;
  fallbackProviderConfig: VercelAIProviderConfig | undefined;
} {
  const { primary, mode, apiKey, model, baseUrl } = input;
  const inactive = { providerConfig: primary, fallbackProviderConfig: undefined };
  if (mode === 'off' || apiKey === undefined || apiKey === '') {
    return inactive;
  }
  if (primary.provider.type === 'tokenfactory') {
    return inactive;
  }
  const tokenFactoryConfig: VercelAIProviderConfig = {
    provider: { type: 'tokenfactory', name: 'tokenfactory' },
    model: { id: model, name: model },
    name: `tokenfactory/${model}`,
    baseUrl,
    apiKey,
    headers: {},
  };
  if (mode === 'force') {
    return { providerConfig: tokenFactoryConfig, fallbackProviderConfig: primary };
  }
  return { providerConfig: primary, fallbackProviderConfig: tokenFactoryConfig };
}

/**
 * Server-wide defaults (see VercelAILLM) apply unless the provider manifest overrides one or both
 * deadlines; a manifest without `stream_timeout` passes `undefined` through so the harness's own
 * defaults are what take effect.
 */
function modelProviderStreamTimeout(
  streamTimeout: ModelProviderStreamTimeout | undefined,
): VercelAILLMConfig['streamTimeout'] {
  if (streamTimeout === undefined) {
    return undefined;
  }
  return {
    firstChunkMs: streamTimeout.first_chunk_ms ?? 300_000,
    chunkMs: streamTimeout.chunk_ms ?? 60_000,
  };
}

/**
 * Resolves a configured server's static headers into their live values, honoring `${env:NAME}` /
 * `${file:PATH}` references. Invoked fresh on every call (never cached), so a rotated env var or
 * file value takes effect on the next call with no restart.
 * @throws {McpConnectionError} naming the reference and header name, never the resolved value
 */
function resolveHeaderSecretReferences(headers: Record<string, string>): RemoteMcpHeaders {
  return async () => {
    const resolved: Record<string, string> = {};
    for (const [headerName, value] of Object.entries(headers)) {
      if (!isSecretReference(value)) {
        resolved[headerName] = value;
        continue;
      }
      try {
        resolved[headerName] = await resolveSecretReference(value);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new McpConnectionError(`MCP header "${headerName}" failed to resolve: ${reason}`, 422, {
          cause: error,
        });
      }
    }
    return { headers: resolved };
  };
}

/**
 * Live request headers for a header / no-auth manifest, whether or not it is stored yet: a
 * manifest being written is checkable before the row exists. DCR is excluded on purpose: its
 * token is keyed by the stored row's id, so it resolves through {@link getMcpConnection}.
 */
export function resolveManifestRequestHeaders(manifest: McpServerManifest): RemoteMcpHeaders {
  const headers = resolveConfiguredMcpRequestHeaders(manifest);
  const hasReference = Object.values(headers).some(isSecretReference);
  return hasReference ? resolveHeaderSecretReferences(headers) : headers;
}

/** Narrows a plain store to the with-auth interface that owns `resolveInvokeHeaders`. */
function isMcpServerWithAuthStore(store: IMcpServerStore): store is IMcpServerWithAuthStore {
  return 'resolveInvokeHeaders' in store;
}

function dcrHeadersResolver(params: {
  record: McpServerRecord;
  tokenStore: IOAuthTokenStore;
  mcpServerStore: IMcpServerStore;
  clientName: string;
  userRef: string;
}): RemoteMcpHeaders {
  const { record, tokenStore, mcpServerStore, clientName, userRef } = params;
  return async () => {
    const manifestAuthType = record.manifest.auth?.type;
    const authType: 'dcr' | 'oauth_client' = manifestAuthType === 'oauth_client' ? 'oauth_client' : 'dcr';
    const oauthParams =
      manifestAuthType === 'oauth_client' && record.manifest.auth?.type === 'oauth_client'
        ? {
            oauthClientId: record.manifest.auth.client_id,
            oauthClientSecret: record.manifest.auth.client_secret,
          }
        : {};
    const result = await resolveMcpAuth({
      tokenStore,
      mcpServerStore,
      serverId: record.id,
      userRef,
      mcpServerUrl: record.manifest.url,
      mcpServerName: record.name,
      clientName,
      authType,
      ...oauthParams,
    });
    if (isMcpAuthRequired(result)) {
      // Wire `id` must match RemoteMCP.id (AgentSpec name), not the DB row ULID —
      // init events, tool-call metadata, and snapshots all key by name.
      return {
        authRequired: {
          servers: [{ id: record.name, name: record.name, auth_url: result.authUrl.href }],
        },
      };
    }
    return { headers: result.headers };
  };
}

/**
 * Load MCP url + headers for a configured server.
 * A with-auth store (see {@link IMcpServerWithAuthStore}) owns DCR/oauth_client and
 * TrueFoundry-managed header resolution through `resolveInvokeHeaders`; delegate to it so a
 * TrueFoundry-managed server's mid-turn re-authorization is honored, not bypassed. A plain store
 * falls back to the generic DCR/oauth_client flow when `tokenStore` and `clientName` are supplied,
 * or the static path otherwise, honoring `${env:NAME}` / `${file:PATH}` references, see
 * {@link resolveManifestRequestHeaders}. Returns undefined when the server is not registered;
 * callers choose the response.
 *
 * TODO: OAuth header resolvers re-run on every RemoteMCP listTools/callTool; cache or gate later.
 */
export async function getMcpConnection({
  tenant_id,
  name,
  store,
  tokenStore,
  clientName,
  userRef,
}: {
  tenant_id: string;
  name: string;
  store: IMcpServerStore;
  tokenStore?: IOAuthTokenStore | undefined;
  clientName?: string | undefined;
  userRef: string;
}): Promise<McpConnection | undefined> {
  const record = await store.getServer({ tenant_id, name });
  if (record === undefined) {
    return undefined;
  }
  // The stored mark is what setup decided at save time. It counts only while the operator still
  // lists the origin, so dropping an origin from the configuration takes effect on the next turn.
  const firstParty =
    record.first_party &&
    isFirstPartyOrigin({ url: record.manifest.url, origins: configuration.FIRST_PARTY_MCP_ORIGINS });
  const needsLiveAuth = record.manifest.auth?.type === 'dcr' || record.manifest.auth?.type === 'oauth_client';
  // Only the live-auth case delegates: a with-auth store's `resolveInvokeHeaders` may be
  // TrueFoundry-managed (mid-turn re-authorization through the gateway) rather than the generic
  // DCR/oauth_client flow below, and that must not be bypassed. A header/no-auth manifest instead
  // always takes the static path beneath, which resolves and validates `${env:}`/`${file:}`
  // secret references; a with-auth store's `resolveInvokeHeaders` does not.
  if (needsLiveAuth && isMcpServerWithAuthStore(store)) {
    return {
      url: record.manifest.url,
      headers: store.resolveInvokeHeaders({ record, userRef }),
      first_party: firstParty,
    };
  }
  if (needsLiveAuth && tokenStore !== undefined && clientName !== undefined) {
    return {
      url: record.manifest.url,
      headers: dcrHeadersResolver({
        record,
        tokenStore,
        mcpServerStore: store,
        clientName,
        userRef,
      }),
      first_party: firstParty,
    };
  }
  return {
    url: record.manifest.url,
    headers: resolveManifestRequestHeaders(record.manifest),
    first_party: firstParty,
  };
}

/**
 * Expand agent_spec skill names into git mounts from the skill store.
 * Wire url/path/ref/description on the request are ignored — the store row wins.
 * Throws HTTPException(422) if any name is not registered or is not a git skill
 * (a registry catalog row must go through the SFY resolve path instead).
 */
export async function resolveGitSkills({
  tenant_id,
  skills,
  store,
}: {
  tenant_id: string;
  skills: readonly { name: string }[];
  store: ISkillStore;
}): Promise<GitSkill[]> {
  if (skills.length === 0) {
    return [];
  }
  const names = skills.map(skill => skill.name);
  const records = await store.listSkills({ tenant_id, names });
  const byName = new Map(records.map(record => [record.name, record]));
  const resolved: GitSkill[] = [];
  for (const skill of skills) {
    const record = byName.get(skill.name);
    if (record === undefined) {
      throw new HTTPException(422, {
        message: `Unknown skill "${skill.name}" — not configured`,
      });
    }
    const git = parseGitSkill(record.manifest);
    if (git === undefined) {
      throw new HTTPException(422, {
        message: `Skill "${skill.name}" is not a git skill`,
      });
    }
    resolved.push({
      type: 'git',
      name: git.name,
      description: git.description,
      url: git.url,
      path: git.path ?? '',
      ref: git.ref,
      requires: git.requires,
      when_to_use: git.when_to_use,
    });
  }
  return resolved;
}

/**
 * Build a runtime SandboxProvider from the configured store row, or the
 * in-memory local fallback when standalone + the cached probe is supported.
 * Builds a fresh provider client per call (no network I/O).
 */
/** Single path segment under the sandboxes parent (`_` when sessionId is missing or unsafe). */
export function localSandboxSessionSegment(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.length === 0 || sessionId.includes('/') || sessionId.includes('..')) {
    return '_';
  }
  return sessionId;
}

export async function resolveSandboxProvider({
  tenant_id,
  store,
  logger,
  sessionId,
}: {
  tenant_id: string;
  store: ISandboxProviderStore;
  logger: Logger;
  sessionId: string;
}): Promise<SandboxProvider | undefined> {
  const record = await store.getSandboxProvider(tenant_id);
  if (record !== undefined) {
    return toSandboxProviderFromRecord({ record, tenant_id, logger });
  }
  if (!configuration.STANDALONE) {
    return undefined;
  }
  const support = getCachedLocalSandboxSupport();
  if (support?.supported !== true) {
    return undefined;
  }
  return new LocalSandboxProvider({
    sandboxRootPathParent: join(configuration.LOCAL_SANDBOX_ROOT_PARENT, localSandboxSessionSegment(sessionId)),
    codeModeSocketParentPath: configuration.CODE_MODE_SOCKET_PARENT,
    support,
    fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
    logger,
  });
}

/**
 * Builds a Sandbox for one turn from a resolved provider and skill mounts.
 */
/** Process-wide cap on concurrent run_code container executions. */
const RUN_CODE_MAX_CONCURRENT_RUNS = 4;

let sharedRunCodeService: RunCodeService | undefined;

/**
 * Process-shared run_code backend. One instance per process: the concurrency
 * semaphore and the stale-container reaper are process-wide resources, and the
 * Docker driver is stateless across turns (per-run containers). Built lazily on
 * the first turn that needs it; the isolation config is validated fail-closed
 * at startup, so construction here only fails on unexpected driver errors.
 * Keeps the first caller's logger for the service lifetime.
 */
function getSharedRunCodeService(logger: Logger): RunCodeService {
  if (sharedRunCodeService === undefined) {
    if (configuration.SANDBOX_ISOLATION_DRIVER !== 'docker') {
      throw new Error(
        `run_code isolation driver "${configuration.SANDBOX_ISOLATION_DRIVER}" is not implemented in this build — refusing to dispatch.`,
      );
    }
    const runCodeLogger = logger.child({ module: 'run-code' });
    const driver = new DockerDriver(
      {
        image: configuration.SANDBOX_IMAGE,
        cosignPublicKeyPath: configuration.SANDBOX_COSIGN_PUBLIC_KEY_PATH,
        stateDir: configuration.SANDBOX_STATE_DIR,
        dockerBinary: undefined,
        cosignBinary: undefined,
        dockerSocketPath: undefined,
        dataDir: configuration.SANDBOX_RUNS_DIR,
        commandTimeoutMs: undefined,
        createTimeoutMs: undefined,
        logger: runCodeLogger,
      },
      undefined,
    );
    sharedRunCodeService = new RunCodeService({
      driver,
      dataDir: configuration.SANDBOX_RUNS_DIR,
      defaultTimeoutSeconds: configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS,
      maxTimeoutSeconds: configuration.SANDBOX_MAX_TIMEOUT_SECONDS,
      memoryMb: configuration.SANDBOX_MEMORY_MB,
      diskMb: configuration.SANDBOX_DISK_MB,
      outputCapKb: configuration.SANDBOX_STDOUT_STDERR_CAP_KB,
      maxConcurrentRuns: RUN_CODE_MAX_CONCURRENT_RUNS,
      imagePullTimeoutSeconds: configuration.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS,
      // Docker ignores the FC pull-before-kill grace.
      harvestGraceMs: 0,
      logger: runCodeLogger,
      now: undefined,
      sleepMs: undefined,
    });
    // the singleton owns the stale-container reaper; starting it here (it
    // is idempotent) covers every construction path, including the lazy
    // per-turn path that never went through server startup.
    sharedRunCodeService.startReaper();
  }
  return sharedRunCodeService;
}

export function buildTurnSandbox(input: {
  provider: SandboxProvider;
  logger: Logger;
  gitSkills: readonly GitSkill[];
  githubGitToken?: string | null | undefined;
  githubConnectorAttached?: boolean | undefined;
  webConnectorAttached?: boolean | undefined;
  fileDownloadEnabled: boolean;
  /**
   * How mounted skills are presented in the <skills> prompt section. Defaults
   * to 'advertise'. Wired from `spec.config.sandbox.skill_prompt_mode` by the
   * caller (turns.ts); left unset here until that call site passes it through.
   */
  skillPromptMode?: SkillPromptMode | undefined;
  existingSandboxId?: string | undefined;
  boundRepository?: BoundRepository | undefined;
  loadBoundRepository?: (() => Promise<BoundRepository | undefined>) | undefined;
  onRepositorySources?: RepositoryCommandSourceObserver | undefined;
  workspaceVerificationCoordinator?: WorkspaceVerificationCoordinator | undefined;
  workspaceLeaseOwnerId?: string | undefined;
  tracing: AgentTracing;
  /**
   * when present, run_code's harvested result files are persisted as turn
   * artifacts at harvest time (before run-root cleanup) so the user can
   * download them after the turn. Absent (e.g. unit tests, non-turn
   * sandboxes), harvest bytes are still discarded at cleanup as before.
   */
  runCodeHarvestPersistence?:
    | {
        tenantId: string;
        sessionId: string;
        turnId: string;
        store: ITurnArtifactStore;
      }
    | undefined;
  /** Session-scoped Sentinel context; sandbox approvals must use the session's services. */
  sentinel: SentinelHostContext;
}): Sandbox {
  // Empty mounter still uploads requested-skills file so existing skills are cleaned up.
  const skillMounter = new SkillMounter(
    { skills: input.gitSkills },
    { promptMode: input.skillPromptMode ?? 'advertise' },
  );
  return new Sandbox({
    provider: input.provider,
    existingSandboxId: input.existingSandboxId,
    fileDownloadEnabled: input.fileDownloadEnabled,
    githubGitToken: input.githubGitToken ?? null,
    githubConnectorAttached: input.githubConnectorAttached ?? false,
    webConnectorAttached: input.webConnectorAttached ?? false,
    boundRepository: input.boundRepository,
    loadBoundRepository: input.loadBoundRepository,
    onRepositorySources: input.onRepositorySources,
    workspaceVerificationCoordinator: input.workspaceVerificationCoordinator,
    workspaceLeaseOwnerId: input.workspaceLeaseOwnerId,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
    mcpConnectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
    ocrLanguages: configuration.DOCUMENT_OCR_LANGUAGES,
    skillMounter,
    runCodeService: getSharedRunCodeService(input.logger),
    // persist harvested bytes per turn before the run root is cleaned up.
    onRunCodeHarvestedFiles:
      input.runCodeHarvestPersistence === undefined
        ? undefined
        : buildRunCodeHarvestSink({
            store: input.runCodeHarvestPersistence.store,
            tenantId: input.runCodeHarvestPersistence.tenantId,
            sessionId: input.runCodeHarvestPersistence.sessionId,
            turnId: input.runCodeHarvestPersistence.turnId,
            logger: input.logger,
          }),
    tracing: input.tracing,
    logger: input.logger,
    sentinel: input.sentinel,
  });
}

/**
 * Cross-checks an AgentSpec against configured models / MCP / skills and
 * sandbox capability. Throws HTTPException(422) for semantic failures.
 * Skills must exist in the skill store (git name) or pass SFY resolve (registry FQN).
 */
export async function validateAgentSpec({
  spec,
  tenant_id,
  modelProviderStore,
  mcpServerStore,
  skillStore,
  sandboxProviderStore,
}: {
  spec: AgentSpec;
  tenant_id: string;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
  skillStore: ISkillStore;
  sandboxProviderStore: ISandboxProviderStore;
}): Promise<void> {
  const resolved = await getModelDetails({
    tenant_id,
    name: spec.model.name,
    store: modelProviderStore,
  });
  const reasoningEffort = spec.model.params?.reasoning_effort;
  if (reasoningEffort !== undefined) {
    const efforts = resolved.modelProperties.reasoning_efforts;
    if (!efforts?.some(effort => effort === reasoningEffort)) {
      throw new HTTPException(422, {
        message: efforts
          ? `Reasoning effort "${reasoningEffort}" is not supported by model "${spec.model.name}"`
          : `Model "${spec.model.name}" does not support configurable reasoning effort`,
      });
    }
  }

  const requestedMcpServers = spec.mcp_servers ?? [];
  if (requestedMcpServers.length > 0) {
    const names = requestedMcpServers.map(server => server.name);
    const configuredNames = new Set(
      (
        await mcpServerStore.listServers({
          tenant_id,
          names,
        })
      ).map(record => record.name),
    );
    const unknown = requestedMcpServers.find(server => !configuredNames.has(server.name));
    if (unknown !== undefined) {
      throw new HTTPException(422, {
        message: `Unknown MCP server "${unknown.name}" — not configured`,
      });
    }
  }

  const requestedSkills = spec.skills ?? [];
  if (requestedSkills.length > 0) {
    // Unknown-skill validation runs first so the error stays specific to what
    // is actually wrong with the request.
    await skillStore.validateAgentSkills({ tenant_id, skills: requestedSkills });
    // Skills only reach the agent through the sandbox: the <skills> prompt
    // section renders from the sandbox's skill mounter, and there is no
    // sandbox at all when it is disabled. Fail loudly here instead of
    // silently advertising nothing.
    if (!spec.config.sandbox.enabled) {
      throw new HTTPException(422, {
        message: 'skills require config.sandbox.enabled: true',
      });
    }
  }

  const wantsSandbox = spec.config.sandbox.enabled;
  const hasSkills = requestedSkills.length > 0;
  if (wantsSandbox || hasSkills) {
    const record = await sandboxProviderStore.getSandboxProvider(tenant_id);
    if (record === undefined && !isLocalSandboxFallbackEnabled()) {
      throw new HTTPException(422, {
        message: hasSkills
          ? 'skills require a sandbox provider — configure via PUT /settings/sandbox-providers'
          : 'sandbox is enabled but no sandbox provider is configured — PUT /settings/sandbox-providers',
      });
    }
  }
}
