/**
 * Host-only memory-provider fields carried alongside the generic connector port.
 *
 * The upstream assistant UI runtime deliberately knows only about generic MCP connectors. Aman
 * stores its memory provider as one of those rows with these extension fields, so the catalog
 * adapter and Memory settings derive their types from this single neutral owner rather than
 * widening the same shape twice.
 */
import type { ReflectBudget } from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

import type { ConnectorBase, CreateConnectorRequest, UpdateConnectorRequest } from './types.js';

export {
  MEMORY_RECALL_MIN_SCORE_LIMITS,
  MEMORY_SETTINGS_LIMITS,
  REFLECT_BUDGETS,
  type ReflectBudget,
} from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';

/** Per-bank tuning as the UI and the SDK carry it (camelCase; the wire is snake_case). */
export type MemoryProviderSettings = {
  /** The memory backend the server resolved (`MEMORY_BACKEND`); local Markdown files need no bank. */
  backend?: 'markdown' | 'hindsight';
  recallTimeoutMs?: number;
  recallQueryWindow?: number;
  recallMinScore?: number;
  recallMaxItems?: number;
  recallMaxEntities?: number;
  curatedEnabled?: boolean;
  curatedMaxModels?: number;
  curatedMaxTokens?: number;
  reflectEnabled?: boolean;
  reflectBudget?: ReflectBudget;
  reflectMaxTokens?: number;
  reflectTimeoutMs?: number;
  /**
   * Skip the memory provider reads on high-confidence trivial turns (short greetings, bare
   * acknowledgements). Defaults to the server's `MEMORY_PRERECALL_GATE_ENABLED` when unset.
   *
   * Kept snake_case, like `screen_enabled`: the generated SDK does not yet declare this field,
   * and its client passes unrecognized object keys through unchanged rather than case-converting
   * them, so the name written here is the literal wire name.
   */
  prerecall_gate_enabled?: boolean;
  /**
   * Screen recalled items and entity summaries with the Prompt Guard classifier before they
   * reach the model. Defaults to the server's `MEMORY_SCREEN_ENABLED` when unset.
   *
   * Kept snake_case, unlike every other field here: the generated SDK does not yet declare this
   * field (it landed on the server first), and its client passes unrecognized object keys through
   * unchanged rather than case-converting them, so the name written here is the literal wire name.
   */
  screen_enabled?: boolean;
};

export type MemoryProviderFields = {
  memoryProvider?: boolean;
  memorySettings?: MemoryProviderSettings;
};

export type ConnectorWithMemoryProvider = ConnectorBase & MemoryProviderFields;
export type CreateConnectorWithMemoryProvider = CreateConnectorRequest & MemoryProviderFields;
export type UpdateConnectorWithMemoryProvider = UpdateConnectorRequest & MemoryProviderFields;

export type MemoryProviderConnector = ConnectorWithMemoryProvider & { memoryProvider: true };
export type MemoryProviderCreateRequest = CreateConnectorWithMemoryProvider & { memoryProvider: boolean };
export type MemoryProviderUpdateRequest = UpdateConnectorWithMemoryProvider & { memoryProvider: boolean };
