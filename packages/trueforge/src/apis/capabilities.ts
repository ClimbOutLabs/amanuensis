import { OpenAPIHono, type z } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import configuration, { UNSTAMPED_BUILD_REF } from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import { PACKAGE_VERSION } from '../packageVersion';
import { getCapabilitiesRoute } from '../routes/capabilityRoutes';
import { getEmbeddingSubsystem } from '../runtime/memory/embeddingRetrieval';
import { findMemoryProviderSettings } from '../runtime/memory/memoryProvider';
import { readMemoryScreenSetting } from '../runtime/memoryScreenSettings';
import { readToolOutputScreenSetting } from '../runtime/toolOutputScreenSettings';
import { isLocalSandboxFallbackEnabled } from '../sandbox/localRuntime';
import { checkSnapshotStatus, readPersistedSnapshotStatus } from '../sandbox/providerUtils';
import { isVoiceAvailable } from '../voice/sttAvailability';
import type { BuildIdentity, GetCapabilitiesResponseSchema, MemoryDefaultsCapability } from '../schemas/capability';
import {
  MemoryEmbeddingsCapabilitySchema,
  MemoryScreenCapabilitySchema,
  SandboxIsolationCapabilitySchema,
  ToolOutputScreenCapabilitySchema,
} from '../schemas/capability';
import type { SandboxIsolationCapability } from '../schemas/capability';
import type { SandboxBuildStatus } from '../schemas/sandboxProvider';
import { TENANT_ID } from './sessions';

/** The `data` object every `/capabilities` response carries, computed once and reused wherever capability flags are needed (e.g. the bug-report bundle's `config_flags`). */
export type CapabilitiesData = z.infer<typeof GetCapabilitiesResponseSchema>['data'];
type MemoryScreenCapabilityData = z.infer<typeof MemoryScreenCapabilitySchema>;
type ToolOutputScreenCapabilityData = NonNullable<CapabilitiesData['tool_output_screen']>;
type MemoryEmbeddingsCapabilityData = z.infer<typeof MemoryEmbeddingsCapabilitySchema>;

/**
 * Why skills are unavailable, keyed off the sandbox build status.
 * `pending` is transient (retry); everything else (no provider / failed / unknown) reads as not configured.
 */
function skillDisabledReason(status: SandboxBuildStatus | undefined): string {
  if (status === 'pending') {
    return 'Skills run in a sandbox whose image is still being prepared — retry shortly.';
  }
  return 'Skills run in a sandbox, which is not configured.';
}

/** Reason reported when the Settings > Memory screen switch cannot be turned on because no classifier service is configured. */
export const MEMORY_SCREEN_NOT_CONFIGURED_REASON = 'No screening service configured';

/**
 * The run_code isolation driver's effective, non-secret config. Read-only:
 * selection happens once at server start; changing it requires a config change
 * and restart. The cosign key path is never exposed — only whether one is set.
 */
function sandboxIsolationCapability(): SandboxIsolationCapability {
  return SandboxIsolationCapabilitySchema.parse({
    isolation_driver: configuration.SANDBOX_ISOLATION_DRIVER,
    image: configuration.SANDBOX_IMAGE,
    default_timeout_seconds: configuration.SANDBOX_DEFAULT_TIMEOUT_SECONDS,
    max_timeout_seconds: configuration.SANDBOX_MAX_TIMEOUT_SECONDS,
    memory_mb: configuration.SANDBOX_MEMORY_MB,
    disk_mb: configuration.SANDBOX_DISK_MB,
    stdout_stderr_cap_kb: configuration.SANDBOX_STDOUT_STDERR_CAP_KB,
    image_pull_timeout_seconds: configuration.SANDBOX_IMAGE_PULL_TIMEOUT_SECONDS,
    network_egress: configuration.SANDBOX_NETWORK_EGRESS,
    cosign_key_configured: configuration.SANDBOX_COSIGN_PUBLIC_KEY_PATH.trim() !== '',
  });
}

/**
 * The memory recall screen's effective on/off status and non-secret config. `configured` reflects
 * `MEMORY_SCREEN_URL` alone (an operator concern); `enabled` also folds in the persisted
 * recall-screen override from Settings > Memory when one is stored, else the per-bank
 * `screen_enabled` user setting, which defaults to `MEMORY_SCREEN_ENABLED` when unset — local DB
 * reads only, no outbound I/O. Deliberately narrow: `enabled`, `configured`, `reason` and
 * `threshold` is all the Settings status card needs. The classifier `MEMORY_SCREEN_URL` is never
 * returned — it names internal infrastructure and can carry userinfo, and this endpoint is
 * readable by every authenticated user, not just admins — and neither is
 * `MEMORY_SCREEN_AUTH_TOKEN`. `threshold` is omitted when the screen is off.
 */
async function memoryScreenCapability(deps: {
  mcpServerStore: IMcpServerStore;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<MemoryScreenCapabilityData> {
  const configured = configuration.MEMORY_SCREEN_URL !== '';
  let settingEnabled = configuration.MEMORY_SCREEN_ENABLED;
  try {
    const stored = await readMemoryScreenSetting({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    if (stored.overridden) {
      settingEnabled = stored.enabled;
    } else {
      const settings = await findMemoryProviderSettings({
        mcpServerStore: deps.mcpServerStore,
        tenantId: TENANT_ID,
      });
      settingEnabled = settings?.screen_enabled ?? configuration.MEMORY_SCREEN_ENABLED;
    }
  } catch (error) {
    deps.logger.warn(
      'Recall screen setting read failed; reporting the recall screen off',
      extractErrorLogFields(error),
    );
  }
  if (!configured) {
    return MemoryScreenCapabilitySchema.parse({
      enabled: false,
      configured: false,
      reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON,
    });
  }
  if (!settingEnabled) {
    return MemoryScreenCapabilitySchema.parse({ enabled: false, configured: true });
  }
  return MemoryScreenCapabilitySchema.parse({
    enabled: true,
    configured: true,
    threshold: configuration.MEMORY_SCREEN_THRESHOLD,
  });
}

/**
 * The live tool-output screen's non-secret status. `enabled` is the effective runtime state:
 * the stored setting (persisted override when one is stored, else `TOOL_OUTPUT_SCREEN_ENABLED`)
 * AND a configured screening service — `false` whenever `MEMORY_SCREEN_URL` is unset,
 * regardless of the stored override, matching what turn runtime construction resolves.
 * It reuses the memory screen's classifier URL, bearer token and threshold, but has its own master
 * switch and timeout. Like the recall screen, it reports `configured: false` (and `enabled: false`)
 * with the shared not-configured reason when `MEMORY_SCREEN_URL` is unset: with no classifier to
 * call, screening cannot run, so the Settings switch must stay off. The URL/token are still never
 * returned through this read-mostly endpoint.
 */
async function toolOutputScreenCapability(deps: {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<ToolOutputScreenCapabilityData> {
  const configured = configuration.MEMORY_SCREEN_URL !== '';
  if (!configured) {
    return ToolOutputScreenCapabilitySchema.parse({
      enabled: false,
      configured: false,
      reason: MEMORY_SCREEN_NOT_CONFIGURED_REASON,
    });
  }
  const { enabled } = await readToolOutputScreenSetting(deps);
  if (!enabled) {
    return ToolOutputScreenCapabilitySchema.parse({ enabled: false, configured: true });
  }
  return ToolOutputScreenCapabilitySchema.parse({
    enabled: true,
    configured: true,
    threshold: configuration.MEMORY_SCREEN_THRESHOLD,
    timeout_ms: configuration.TOOL_OUTPUT_SCREEN_TIMEOUT_MS,
  });
}

/** The resolved `MEMORY_*` defaults, straight off configuration; no I/O, no credentials. */
function memoryDefaultsCapability(isAdmin: boolean): MemoryDefaultsCapability {
  return {
    backend: configuration.MEMORY_BACKEND,
    // The resolved Markdown directory is a host filesystem path: disclose it only to
    // admins. Non-admin authenticated users can read capabilities; they get the rest
    // of the memory status without the path.
    ...(isAdmin ? { markdown_dir: configuration.MEMORY_MARKDOWN_DIR } : {}),
    recall_timeout_ms: configuration.MEMORY_RECALL_TIMEOUT_MS,
    recall_query_window: configuration.MEMORY_RECALL_QUERY_WINDOW,
    recall_min_score: configuration.MEMORY_RECALL_MIN_SCORE,
    recall_max_items: configuration.MEMORY_RECALL_MAX_ITEMS,
    recall_max_entities: configuration.MEMORY_RECALL_MAX_ENTITIES,
    prerecall_gate_enabled: configuration.MEMORY_PRERECALL_GATE_ENABLED,
    curated_enabled: configuration.MEMORY_CURATED_ENABLED,
    curated_max_models: configuration.MEMORY_CURATED_MAX_MODELS,
    curated_max_tokens: configuration.MEMORY_CURATED_MAX_TOKENS,
    reflect_enabled: configuration.MEMORY_REFLECT_ENABLED,
    reflect_budget: configuration.MEMORY_REFLECT_BUDGET,
    reflect_max_tokens: configuration.MEMORY_REFLECT_MAX_TOKENS,
    reflect_timeout_ms: configuration.MEMORY_REFLECT_TIMEOUT_MS,
  };
}

/**
 * Live meaning-based recall status for one tenant. Reads the embedding
 * subsystem's in-memory status only — constructing it starts no download and
 * performs no I/O, so this stays safe on the read-mostly capabilities route
 * and the zero-egress bug-report path. `detail` is a static template with
 * counts; it never carries memory text.
 */
function memoryEmbeddingsCapability(tenantId: string): MemoryEmbeddingsCapabilityData {
  if (!configuration.MEMORY_EMBEDDINGS_ENABLED || configuration.MEMORY_BACKEND !== 'markdown') {
    return MemoryEmbeddingsCapabilitySchema.parse({
      enabled: false,
      state: 'unavailable',
      detail: 'Meaning-based recall is off on this server.',
      indexed_entries: 0,
    });
  }
  const subsystem = getEmbeddingSubsystem({
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: tenantId,
    modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
    batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
  });
  const status = subsystem.getStatus();
  return MemoryEmbeddingsCapabilitySchema.parse({
    enabled: true,
    state: status.state,
    detail: status.detail,
    indexed_entries: status.indexedEntries,
  });
}

/**
 * Which build is answering, so a deployment can be identified without reaching the host.
 * An unstamped build omits `ref` rather than echoing the placeholder, so a `ref` on the
 * wire always names a real source reference.
 */
export function toBuildIdentity({ version, buildRef }: { version: string; buildRef: string }): BuildIdentity {
  return buildRef === UNSTAMPED_BUILD_REF ? { version } : { version, ref: buildRef };
}

export interface ComputeCapabilitiesDataDeps<TTransaction> {
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
  /** Whether the requesting identity is an admin (settings capability gate). */
  isAdmin: boolean;
  /** Caller's tenant; defaults to {@link TENANT_ID} for callers with no live request (e.g. bug reports). */
  tenantId?: string;
}

/**
 * Maps a resolved sandbox build status plus a local (zero-egress) read of the memory-provider
 * settings to the capability flags. The memory-provider read is a local DB read only, so this
 * stays safe on both the capabilities route and the zero-egress bug-report config_flags path.
 */
async function capabilitiesFromSandboxStatus({
  status,
  isAdmin,
  tenantId,
  mcpServerStore,
  globalSettingsStore,
  logger,
}: {
  status: SandboxBuildStatus | undefined;
  isAdmin: boolean;
  tenantId: string;
  mcpServerStore: IMcpServerStore;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<CapabilitiesData> {
  const sandboxEnabled = status === 'ready' || (status === undefined && isLocalSandboxFallbackEnabled());
  return {
    sandbox: { enabled: sandboxEnabled },
    skill: sandboxEnabled ? { enabled: true } : { enabled: false, reason: skillDisabledReason(status) },
    settings: { enabled: isAdmin },
    voice: { enabled: isVoiceAvailable() },
    memory_screen: await memoryScreenCapability({
      mcpServerStore,
      globalSettingsStore,
      logger,
    }),
    tool_output_screen: await toolOutputScreenCapability({ globalSettingsStore, logger }),
    memory_defaults: memoryDefaultsCapability(isAdmin),
    memory_embeddings: memoryEmbeddingsCapability(tenantId),
    sandbox_isolation: sandboxIsolationCapability(),
    build: toBuildIdentity({ version: PACKAGE_VERSION, buildRef: configuration.BUILD_REF }),
  };
}

/**
 * The `/capabilities` response body, computed once so every caller reads the same
 * sandbox/skill/settings/build logic. Sandbox is usable only when a provider is configured AND
 * its image build reports ready, so this refreshes the persisted status (and re-activates an idle
 * snapshot), which can call the Daytona provider. It therefore MUST NOT be used by a path that is
 * required to stay local/zero-egress — {@link readLocalCapabilitiesData} is the read-only variant.
 * Fails closed (sandbox disabled) if the refresh throws.
 */
export async function computeCapabilitiesData<TTransaction>(
  deps: ComputeCapabilitiesDataDeps<TTransaction>,
): Promise<CapabilitiesData> {
  let status: SandboxBuildStatus | undefined;
  try {
    const refreshed = await checkSnapshotStatus({
      store: deps.sandboxProviderStore,
      tenant_id: deps.tenantId ?? TENANT_ID,
      logger: deps.logger,
    });
    status = refreshed?.status;
  } catch (error) {
    deps.logger.warn('Sandbox image status check failed; reporting sandbox disabled', extractErrorLogFields(error));
  }
  return capabilitiesFromSandboxStatus({
    status,
    isAdmin: deps.isAdmin,
    tenantId: deps.tenantId ?? TENANT_ID,
    mcpServerStore: deps.mcpServerStore,
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
  });
}

/**
 * The same capability flags as {@link computeCapabilitiesData}, but sourced only from the
 * persisted sandbox status: no remote refresh, no write-back, zero egress. Used by the
 * bug-report bundle, which is a purely local, read-only operation: it
 * must never dial the sandbox provider or mutate sandbox state just to report `config_flags`.
 * Fails closed (sandbox disabled) if the local read throws.
 */
export async function readLocalCapabilitiesData<TTransaction>(
  deps: ComputeCapabilitiesDataDeps<TTransaction>,
): Promise<CapabilitiesData> {
  let status: SandboxBuildStatus | undefined;
  try {
    const persisted = await readPersistedSnapshotStatus({
      store: deps.sandboxProviderStore,
      tenant_id: deps.tenantId ?? TENANT_ID,
    });
    status = persisted?.status;
  } catch (error) {
    deps.logger.warn('Sandbox status read failed; reporting sandbox disabled', extractErrorLogFields(error));
  }
  return capabilitiesFromSandboxStatus({
    status,
    isAdmin: deps.isAdmin,
    tenantId: deps.tenantId ?? TENANT_ID,
    mcpServerStore: deps.mcpServerStore,
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
  });
}

export function createCapabilitiesRouter<TTransaction>(deps: {
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}) {
  const router = new OpenAPIHono();
  router.openapi(getCapabilitiesRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const data = await computeCapabilitiesData({
      sandboxProviderStore: deps.resolveSandboxProviderStore(c),
      mcpServerStore: deps.mcpServerStore,
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
      tenantId: requestContext.tenant_id,
      isAdmin: hasAdminRole(requestContext),
    });
    return c.json({ data }, 200);
  });
  return router;
}
