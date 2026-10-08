import type { CompletionUsage } from './LLMTypes';

/**
 * Conservative characters-per-token divisor used by estimateTokensForString.
 *
 * Plain prose tokenizes near 4 chars/token on the DeepSeek tokenizer, but the
 * strings this estimates are mostly JSON-serialized chat history (message
 * envelopes, tool-call names and arguments) plus code, which run denser:
 * production histories measured 3-3.9 chars/token. The estimate feeds
 * compaction budgets and the pre-flight context-limit guard, where
 * undercounting lets a request through that the provider then rejects, while
 * overcounting only compacts a little early. 3 chars/token is therefore the
 * safe bound for Latin-script content. CJK scripts tokenize denser than this
 * bound; see the known-limitation note on TOKEN_BUDGET_SAFETY_MARGIN.
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
