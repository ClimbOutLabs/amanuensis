import configuration from '../../config';
import type { MemoryProviderSettings } from '../../schemas/mcpServer';
import type { MemoryConfig } from './memoryCapability';

/** The server-wide memory defaults, as the environment sets them. */
export function serverMemoryConfig(): MemoryConfig {
  return {
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
    pages: {
      maxCount: configuration.MEMORY_PAGES_MAX_COUNT,
      maxTokens: configuration.MEMORY_PAGES_MAX_TOKENS,
    },
  };
}

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
