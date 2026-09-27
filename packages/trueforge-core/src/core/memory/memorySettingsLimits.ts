/**
 * One owner for the bounds of per-bank memory tuning. The server API validates `memory_settings`
 * with these, the Settings > Memory form renders and pre-validates with them, and the server-wide
 * `MEMORY_*` deadlines are capped by the same maximum, so the three can never disagree.
 */
export const REFLECT_BUDGETS = ['low', 'mid', 'high'] as const;
export type ReflectBudget = (typeof REFLECT_BUDGETS)[number];

export interface IntegerBounds {
  min: number;
  max: number;
}

/**
 * The longest any memory deadline may be, server-wide or per bank. A memory-provider write runs
 * the bank's recall as its check, so the browser keeps that request alive for slightly longer
 * than this and the two limits are derived from the one number.
 */
export const MEMORY_PROVIDER_MAX_TIMEOUT_MS = 120_000;

export const MEMORY_SETTINGS_LIMITS = {
  recallTimeoutMs: { min: 500, max: MEMORY_PROVIDER_MAX_TIMEOUT_MS },
  recallQueryWindow: { min: 1, max: 20 },
  recallMaxItems: { min: 1, max: 200 },
  recallMaxEntities: { min: 0, max: 200 },
  curatedMaxModels: { min: 1, max: 20 },
  curatedMaxTokens: { min: 64, max: 8192 },
  reflectMaxTokens: { min: 64, max: 8192 },
  reflectTimeoutMs: { min: 500, max: MEMORY_PROVIDER_MAX_TIMEOUT_MS },
} as const satisfies Record<string, IntegerBounds>;

/**
 * Bounds for `recall_min_score`: the provider's own relevance score is normalized to [0, 1], so
 * the floor a caller may set is the same interval. Kept separate from
 * {@link MEMORY_SETTINGS_LIMITS} (whose entries bound an integer) since a score is a fraction.
 */
export const MEMORY_RECALL_MIN_SCORE_LIMITS: IntegerBounds = { min: 0, max: 1 };
