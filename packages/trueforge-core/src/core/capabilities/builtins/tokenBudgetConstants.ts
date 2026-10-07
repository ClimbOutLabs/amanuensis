/**
 * Token budget safety margin (in tokens) held back from the compaction input
 * budget to cover provider-added overhead (BOS token, template overhead,
 * post-compaction message additions) and estimator slop.
 *
 * Kept in a leaf module so UI clients can import the constant without
 * pulling in the full ContextCompaction module graph.
 */
export const TOKEN_BUDGET_SAFETY_MARGIN = 512;
