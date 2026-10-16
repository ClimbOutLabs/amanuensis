/**
 * Resolves the configured max output tokens: max_completion_tokens preferred, the deprecated
 * max_tokens as fallback; undefined when unset or unusable (non-numeric, non-finite, or negative).
 * Shared by the model request, the compaction threshold and the token pre-flight guard so their
 * budgets cannot drift apart.
 */
export function resolveMaxOutputTokens(
  params: { max_completion_tokens?: unknown; max_tokens?: unknown } | undefined,
): number | undefined {
  const configured = params?.max_completion_tokens ?? params?.max_tokens;
  return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? configured : undefined;
}
