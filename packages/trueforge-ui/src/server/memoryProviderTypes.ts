/**
 * Host-only memory-provider fields carried alongside the generic connector port.
 *
 * The upstream assistant UI runtime deliberately knows only about generic MCP connectors. The
 * server stores the memory provider as one of those rows with these extension fields; the SDK owns
 * their shape, so the catalog adapter and Memory settings derive it from there.
 */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { ConnectorBase, CreateConnectorRequest, UpdateConnectorRequest } from './types.js';

export {
  MEMORY_RECALL_MIN_SCORE_LIMITS,
  MEMORY_SETTINGS_LIMITS,
  REFLECT_BUDGETS,
  type ReflectBudget,
} from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

export type MemoryProviderFields = Pick<TrueForgeApi.RemoteMcpServerManifest, 'memoryProvider' | 'memorySettings'>;

export type ConnectorWithMemoryProvider = ConnectorBase & MemoryProviderFields;
export type CreateConnectorWithMemoryProvider = CreateConnectorRequest & MemoryProviderFields;
export type UpdateConnectorWithMemoryProvider = UpdateConnectorRequest & MemoryProviderFields;

export type MemoryProviderConnector = ConnectorWithMemoryProvider & { memoryProvider: true };
export type MemoryProviderCreateRequest = CreateConnectorWithMemoryProvider & { memoryProvider: boolean };
export type MemoryProviderUpdateRequest = UpdateConnectorWithMemoryProvider & { memoryProvider: boolean };
