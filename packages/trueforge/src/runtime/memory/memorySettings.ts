import type { MemoryProviderSettings } from '../../schemas/mcpServer';
import type { MemoryConfig } from './memoryCapability';

/**
 * Per-bank tuning from Settings > Memory laid over the server-wide defaults. Only fields the
 * user set are applied; a blank field in the form is absent on the wire and keeps the default,
 * so the environment and the form never disagree about a value that was not set here.
 */
export function applyMemorySettings(settings: MemoryProviderSettings | undefined, base: MemoryConfig): MemoryConfig {
  if (settings === undefined) {
    return base;
  }
  return {
    ...base,
    recallTimeoutMs: settings.recall_timeout_ms ?? base.recallTimeoutMs,
    recallQueryWindow: settings.recall_query_window ?? base.recallQueryWindow,
    recallMinScore: settings.recall_min_score ?? base.recallMinScore,
    recallMaxItems: settings.recall_max_items ?? base.recallMaxItems,
    recallMaxEntities: settings.recall_max_entities ?? base.recallMaxEntities,
    preRecallGateEnabled: settings.prerecall_gate_enabled ?? base.preRecallGateEnabled,
    screen: {
      ...base.screen,
      enabled: settings.screen_enabled ?? base.screen.enabled,
    },
    curated: {
      enabled: settings.curated_enabled ?? base.curated.enabled,
      maxModels: settings.curated_max_models ?? base.curated.maxModels,
      maxTokens: settings.curated_max_tokens ?? base.curated.maxTokens,
    },
    reflect: {
      enabled: settings.reflect_enabled ?? base.reflect.enabled,
      budget: settings.reflect_budget ?? base.reflect.budget,
      maxTokens: settings.reflect_max_tokens ?? base.reflect.maxTokens,
      timeoutMs: settings.reflect_timeout_ms ?? base.reflect.timeoutMs,
    },
  };
}
