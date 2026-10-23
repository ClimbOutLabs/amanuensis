/**
 * Built-in Harness → AgentUIServer factory for `<TrueForgeUI server={{ type: "trueforge", … }} />`.
 */
import { createTrueFoundryServer } from '../../server/createTrueFoundryServer.js';
import type { CatalogServer, PermissionsServer } from '../../server/types.js';
import { createHarnessAgentMetricsServer } from './agentMetricsServer.js';
import { createHarnessAgentSessionsServer } from './agentSessionsServer.js';
import { createHarnessBuilderServer } from './builderServer.js';
import { createChatImagesCatalog } from './catalogs/chatImagesCatalog.js';
import { createConnectorCatalog } from './catalogs/connectorCatalog.js';
import { createMemoryScreenCatalog } from './catalogs/memoryScreenCatalog.js';
import { createMemorySummarizeCatalog } from './catalogs/memorySummarizeCatalog.js';
import { createMemoryVaultCatalog } from './catalogs/memoryVaultCatalog.js';
import { createModelProviderCatalog } from './catalogs/modelProviderCatalog.js';
import { createSandboxProviderCatalog } from './catalogs/sandboxProviderCatalog.js';
import { createSkillCatalog } from './catalogs/skillCatalog.js';
import { createTokenFactoryUsageCatalog } from './catalogs/tokenFactoryUsageCatalog.js';
import { createToolOutputScreenCatalog } from './catalogs/toolOutputScreenCatalog.js';
import { createHarnessChatServer } from './chatServer.js';
import { createTrueForgeClient, type CreateTrueForgeClientOptions } from './client.js';
import { createHarnessPermissionsServer } from './permissionsServer.js';
import { createScheduleServer } from './schedules/scheduleServer.js';
import type { HarnessAgentSpec } from './types.js';

export { createHarnessAgentMetricsServer, type CreateHarnessAgentMetricsServerOptions } from './agentMetricsServer.js';
export {
  createHarnessAgentSessionsServer,
  type CreateHarnessAgentSessionsServerOptions,
} from './agentSessionsServer.js';
export {
  createHarnessBuilderServer,
  modelProviderLogosByName,
  toModelSelection,
  type CreateHarnessBuilderServerOptions,
} from './builderServer.js';
export {
  createConnectorCatalog,
  toHarnessAuth,
  toHarnessManifest as toHarnessConnectorManifest,
  toUiConnector,
  toUiConnectorFromReadEntry,
  type HarnessConnectorCatalog,
} from './catalogs/connectorCatalog.js';
export {
  createModelProviderCatalog,
  toHarnessModelProvider,
  toUiCatalogModelProviderEntry,
  toUiModelProvider,
  type UiStreamTimeout,
} from './catalogs/modelProviderCatalog.js';
export {
  configFromHarness,
  createSandboxProviderCatalog,
  filterUiSandboxProviders,
  toHarnessManifest as toHarnessSandboxManifest,
  toUiSandboxProvider,
  toUiSandboxProviderListEntry,
} from './catalogs/sandboxProviderCatalog.js';
export { createSkillCatalog, toHarnessManifest as toHarnessSkillManifest, toUiSkill } from './catalogs/skillCatalog.js';
export {
  createHarnessChatServer,
  listDocumentIngestionTurnContext,
  listMemoryTurnContext,
  listModelUsageTurnContext,
  subscribeToDocumentIngestion,
  toHarnessAgentSpec,
  toUiAgentSpec,
  type CreateHarnessChatServerOptions,
  type DocumentIngestionFileStatus,
  type DocumentIngestionLiveEvent,
  type DocumentIngestionTurnContext,
  type MemoryTurnContext,
  type ModelUsageTurnContext,
} from './chatServer.js';
export { createTrueForgeClient } from './client.js';
export type { CreateTrueForgeClientOptions } from './client.js';
export { getCapabilities, listConfiguredMcpServers, listModels, listSkills, readMemoryBackend } from './lists.js';
export type { BuildIdentity } from './lists.js';
export { createHarnessPermissionsServer, type CreateHarnessPermissionsServerOptions } from './permissionsServer.js';
export { createScheduleServer } from './schedules/scheduleServer.js';
export {
  isPendingApprovalsError,
  publishBlockedSend,
  subscribeToBlockedSend,
  type HarnessChatServerExtensions,
  type PendingApprovalInfo,
  type SessionTipInfo,
} from './sessionResync.js';
export type { HarnessAgentSpec, HarnessAuxiliaryModels, HarnessMcpServerMount, HarnessSkillMount } from './types.js';

export type CreateTrueForgeAgentUIServerOptions = CreateTrueForgeClientOptions & {
  /** Override the default Harness settings catalogs. */
  catalog?: CatalogServer;
  /** Optional host-provided resource permissions port. */
  permissions?: PermissionsServer;
};

/**
 * Compose chat + builder + agent sessions + default settings catalogs into an `AgentUIServer`.
 */
export function createTrueForgeAgentUIServer(options: CreateTrueForgeAgentUIServerOptions = {}) {
  const { catalog: catalogOverride, permissions, ...clientOptions } = options;
  const client = createTrueForgeClient(clientOptions);
  const catalog =
    catalogOverride ??
    ({
      modelCatalog: createModelProviderCatalog(client, clientOptions),
      connectorCatalog: createConnectorCatalog(client, clientOptions),
      skillCatalog: createSkillCatalog(client),
      sandboxCatalog: createSandboxProviderCatalog(client),
    } satisfies CatalogServer);

  const server = createTrueFoundryServer<HarnessAgentSpec>({
    chatServer: createHarnessChatServer({ client }),
    ...createHarnessBuilderServer({ client }),
    catalog,
    sessions: createHarnessAgentSessionsServer({ ...clientOptions, client }),
    metrics: createHarnessAgentMetricsServer({ ...clientOptions, client }),
    schedules: createScheduleServer({ client }),
    permissions: permissions ?? createHarnessPermissionsServer({ client }),
  });

  // Companion to the capabilities flag: an extra server surface that is not part of the
  // runtime's AgentUIServer type, so the Settings toggle has a UI-controlled switch that
  // reports "not supported" on other servers.
  return {
    ...server,
    toolOutputScreen: createToolOutputScreenCatalog(clientOptions),
    chatImages: createChatImagesCatalog(clientOptions),
    memoryScreen: createMemoryScreenCatalog(clientOptions),
    memorySummarize: createMemorySummarizeCatalog(clientOptions),
    memoryVault: createMemoryVaultCatalog(clientOptions),
    tokenFactoryUsage: createTokenFactoryUsageCatalog(client),
  };
}

export {
  createMemoryVaultCatalog,
  memoryVaultErrorMessage,
  type MemoryVaultCatalog,
  type MemoryVaultEntry,
  type MemoryVaultSharing,
} from './catalogs/memoryVaultCatalog.js';
