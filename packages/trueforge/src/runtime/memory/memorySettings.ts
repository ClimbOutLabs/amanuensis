import configuration from '../../config';
import type { MemoryConfig } from './memoryCapability';

/** The server-wide memory defaults, as the environment sets them. */
export function serverMemoryConfig(): MemoryConfig {
  return {
    recallMaxTokens: configuration.MEMORY_RECALL_MAX_TOKENS,
    recallTimeoutMs: configuration.MEMORY_RECALL_TIMEOUT_MS,
    recallQueryWindow: configuration.MEMORY_RECALL_QUERY_WINDOW,
    recallMinScore: configuration.MEMORY_RECALL_MIN_SCORE,
    recallMaxItems: configuration.MEMORY_RECALL_MAX_ITEMS,
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
    pages: {
      maxCount: configuration.MEMORY_PAGES_MAX_COUNT,
      maxTokens: configuration.MEMORY_PAGES_MAX_TOKENS,
    },
  };
}

/** The Settings switch for the recall screen laid over the server-wide default; unset keeps the default. */
export function withMemoryScreenOverride({
  base,
  override,
}: {
  base: MemoryConfig;
  override: boolean | undefined;
}): MemoryConfig {
  return override === undefined ? base : { ...base, screen: { ...base.screen, enabled: override } };
}
