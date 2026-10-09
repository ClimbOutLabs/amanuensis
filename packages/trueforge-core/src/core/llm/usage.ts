import type { CompletionUsage } from './LLMTypes';

/**
 * Heuristic fallback token estimate. Used ONLY where no ILLM is available
 * (usage breakdowns, thresholds, displays). Never use for the pre-flight
 * context-limit guard or compaction budgets; those must use
 * ILLM.countTokens(), which runs the provider's actual tokenizer.
 *
 * Uses a conservative 3 chars/token divisor: plain prose tokenizes near 4
 * chars/token, but the strings this estimates are mostly JSON-serialized
 * chat history plus code, which run denser (production histories measured
 * 3-3.9 chars/token on the DeepSeek tokenizer). Overcounting only compacts
 * a little early, while undercounting lets through requests the provider
 * then rejects. CJK scripts tokenize denser than this bound.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 3;

export function estimateTokensForString(s: string): number {
  return s.length / ESTIMATE_CHARS_PER_TOKEN;
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

export function mergeUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cache_read_tokens: sumOptional(a.cache_read_tokens, b.cache_read_tokens),
    cache_write_tokens: sumOptional(a.cache_write_tokens, b.cache_write_tokens),
    reasoning_tokens: sumOptional(a.reasoning_tokens, b.reasoning_tokens),
    cost_in_usd: sumOptional(a.cost_in_usd, b.cost_in_usd),
  };
}
