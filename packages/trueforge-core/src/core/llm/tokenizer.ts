import type { VercelAIProviderName } from './VercelAILLM';

/**
 * Counts tokens in text using a provider's actual tokenizer.
 * Implementations return exact counts from the provider, never estimates.
 * All methods are async because some tokenizers require a network call.
 */
export interface TokenCounter {
  countTokens(text: string): Promise<number>;
}

/**
 * Configuration for creating a provider-specific token counter.
 * Mirrors the fields VercelAILLM needs to route to the right tokenizer.
 */
export interface TokenCounterConfig {
  providerType: VercelAIProviderName;
  /** Provider-facing model identifier, sent to tokenizer endpoints that require it. */
  modelId: string;
  /** Base URL override; when set, the /tokenize endpoint is tried first. */
  baseUrl?: string | undefined;
  /** API key for authenticated tokenizer endpoints. */
  apiKey: string;
  /** Extra headers forwarded to tokenizer endpoints. */
  headers: Record<string, string>;
  /** AbortSignal for cancelling in-flight tokenizer requests. */
  signal?: AbortSignal | undefined;
}

/**
 * Conservative characters-per-token divisor for the heuristic fallback.
 * Used only when no provider tokenizer is available. Plain prose tokenizes
 * near 4 chars/token, but the strings this estimates are mostly JSON-serialized
 * chat history plus code, which run denser: production histories measured
 * 3-3.9 chars/token on the DeepSeek tokenizer. 3 is the safe lower bound for
 * Latin-script content: overcounting only triggers earlier compaction, while
 * undercounting lets through requests the provider then rejects.
 */
export const HEURISTIC_CHARS_PER_TOKEN = 3;

/**
 * Heuristic fallback token counter. Used only when no provider tokenizer
 * is reachable. Deliberately overcounts; never use as the primary method
 * when an accurate tokenizer exists.
 */
export class HeuristicTokenCounter implements TokenCounter {
  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
  }
}

/**
 * vLLM /tokenize endpoint counter. Works for any vLLM server and any
 * OpenAI-compatible server that implements the endpoint. The count comes
 * from the model's own tokenizer, so it exactly matches what the
 * inference request will be charged.
 */
export class VLLMHttpTokenCounter implements TokenCounter {
  private readonly baseUrl: string;
  private readonly modelId: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly signal: AbortSignal | undefined;

  constructor(config: {
    baseUrl: string;
    modelId: string;
    apiKey: string;
    headers: Record<string, string>;
    signal?: AbortSignal | undefined;
  }) {
    // Strip trailing slashes so endpoint joining is predictable.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelId = config.modelId;
    this.apiKey = config.apiKey;
    this.headers = config.headers;
    this.signal = config.signal;
  }

  async countTokens(text: string): Promise<number> {
    const response = await fetch(`${this.baseUrl}/tokenize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ model: this.modelId, prompt: text }),
      signal: this.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Tokenize endpoint returned ${String(response.status)} for ${this.baseUrl}/tokenize`,
      );
    }
    const data = (await response.json()) as { count?: unknown; tokens?: unknown };
    if (typeof data.count === 'number') {
      return data.count;
    }
    if (Array.isArray(data.tokens)) {
      return data.tokens.length;
    }
    throw new Error('Tokenize endpoint returned an unexpected shape');
  }
}

/**
 * Tiktoken-based counter for OpenAI models. Uses the model's native BPE
 * encoding via the tiktoken library, loaded dynamically so the dependency
 * is only required when an OpenAI provider is actually configured.
 */
export class TiktokenTokenCounter implements TokenCounter {
  private readonly modelId: string;
  private encoderPromise: Promise<{ encode(text: string): number[] }> | undefined;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  private async getEncoder(): Promise<{ encode(text: string): number[] }> {
    if (this.encoderPromise === undefined) {
      this.encoderPromise = import('@dqbd/tiktoken').then(mod => mod.encoding_for_model(this.modelId));
    }
    return this.encoderPromise;
  }

  async countTokens(text: string): Promise<number> {
    const encoder = await this.getEncoder();
    return encoder.encode(text).length;
  }
}

/**
 * tiktoken throws for model ids outside its registry (for example the model
 * ids served by vLLM). Only that failure falls through to /tokenize; any
 * other error propagates so the caller can fall back cleanly.
 */
function isUnknownTiktokenModelError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unknown model');
}

/**
 * Token counter for OpenAI-compatible endpoints, which are commonly vLLM
 * servers. tiktoken counts OpenAI's own model ids exactly and locally; when
 * tiktoken does not recognize the model id, the serving model's /tokenize
 * endpoint is the accurate source instead of the heuristic fallback.
 */
class OpenAICompatibleTokenCounter implements TokenCounter {
  private readonly tiktoken: TiktokenTokenCounter;
  private readonly vllm: VLLMHttpTokenCounter;

  constructor(config: { tiktoken: TiktokenTokenCounter; vllm: VLLMHttpTokenCounter }) {
    this.tiktoken = config.tiktoken;
    this.vllm = config.vllm;
  }

  async countTokens(text: string): Promise<number> {
    try {
      return await this.tiktoken.countTokens(text);
    } catch (error) {
      if (!isUnknownTiktokenModelError(error)) {
        throw error;
      }
      return this.vllm.countTokens(text);
    }
  }
}

/**
 * Anthropic token counting API counter. Uses the official count_tokens
 * endpoint, which accepts the same message shape as the messages API.
 * Text is wrapped in a single user message for counting.
 */
export class AnthropicTokenCounter implements TokenCounter {
  private readonly modelId: string;
  private readonly apiKey: string;
  private readonly signal: AbortSignal | undefined;

  constructor(config: { modelId: string; apiKey: string; signal?: AbortSignal | undefined }) {
    this.modelId = config.modelId;
    this.apiKey = config.apiKey;
    this.signal = config.signal;
  }

  async countTokens(text: string): Promise<number> {
    const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: [{ role: 'user', content: text }],
      }),
      signal: this.signal,
    });
    if (!response.ok) {
      throw new Error(`Anthropic count_tokens returned ${String(response.status)}`);
    }
    const data = (await response.json()) as { input_tokens?: unknown };
    if (typeof data.input_tokens === 'number') {
      return data.input_tokens;
    }
    throw new Error('Anthropic count_tokens returned an unexpected shape');
  }
}

/**
 * In-memory cache decorator for token counters. The pre-flight guard counts
 * the same instruction and tool definitions on every turn; caching avoids
 * repeat tokenizer calls for unchanged strings. Bounded to prevent
 * unbounded growth on long-running processes.
 */
export class CachedTokenCounter implements TokenCounter {
  private readonly inner: TokenCounter;
  private readonly cache = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(inner: TokenCounter, maxEntries = 500) {
    this.inner = inner;
    this.maxEntries = maxEntries;
  }

  async countTokens(text: string): Promise<number> {
    // Short strings are cheap to recount and pollute the cache; only cache
    // longer inputs where the tokenizer call actually costs.
    if (text.length < 1000) {
      return this.inner.countTokens(text);
    }
    const key = `${String(text.length)}:${hashString(text)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const count = await this.inner.countTokens(text);
    if (this.cache.size >= this.maxEntries) {
      // Evict the oldest entry; insertion order is preserved by Map.
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, count);
    return count;
  }
}

/** FNV-1a 32-bit hash for cache keys. Fast and sufficient for non-adversarial use. */
function hashString(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Creates the most accurate available token counter for a provider.
 * Resolution order:
 * 1. Anthropic's count_tokens API for anthropic providers.
 * 2. tiktoken for OpenAI model ids; on OpenAI-compatible endpoints
 *    (baseUrl set) an unknown model id falls through to the serving
 *    model's /tokenize endpoint.
 * 3. The vLLM /tokenize endpoint when a baseUrl is set.
 * 4. Conservative heuristic fallback. Overcounts by design; used only when
 *    no accurate tokenizer is reachable.
 *
 * The caller should wrap the result in CachedTokenCounter for repeated counts.
 */
export function createTokenCounter(config: TokenCounterConfig): TokenCounter {
  const { providerType, modelId, baseUrl, apiKey, headers, signal } = config;

  // Anthropic has a dedicated counting API that does not need a baseUrl.
  if (providerType === 'anthropic') {
    return new AnthropicTokenCounter({ modelId, apiKey, signal });
  }

  // OpenAI models use tiktoken locally; exact and no network call. A custom
  // baseUrl means an OpenAI-compatible endpoint (commonly vLLM) rather than
  // api.openai.com, and tiktoken does not know those model ids; fall through
  // to the serving model's /tokenize endpoint in that case.
  if (providerType === 'openai') {
    const tiktoken = new TiktokenTokenCounter(modelId);
    if (baseUrl !== undefined && baseUrl.length > 0) {
      return new OpenAICompatibleTokenCounter({
        tiktoken,
        vllm: new VLLMHttpTokenCounter({ baseUrl, modelId, apiKey, headers, signal }),
      });
    }
    return tiktoken;
  }

  // Any provider with a baseUrl may be vLLM-backed. The /tokenize probe
  // happens lazily on first count; VLLMHttpTokenCounter throws on non-2xx,
  // and callers that need a hard guarantee should catch and fall back.
  if (baseUrl !== undefined && baseUrl.length > 0) {
    return new VLLMHttpTokenCounter({ baseUrl, modelId, apiKey, headers, signal });
  }

  // No baseUrl and no native tokenizer: heuristic fallback.
  return new HeuristicTokenCounter();
}
