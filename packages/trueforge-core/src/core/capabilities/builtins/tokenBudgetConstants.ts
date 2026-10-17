/**
 * Token budget safety margin (in tokens) held back from the compaction input
 * budget to cover provider-added overhead (BOS token, template overhead,
 * post-compaction message additions) and estimator slop.
 *
 * Kept in a leaf module so UI clients can import the constant without
 * pulling in the full ContextCompaction module graph.
 */
export const TOKEN_BUDGET_SAFETY_MARGIN = 512;

/** Compaction threshold used when the model's context length is unknown. */
export const DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS = 50 * 1000;
