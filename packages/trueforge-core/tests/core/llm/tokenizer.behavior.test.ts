/**
 * Behavioral tests for provider token counters.
 * Halt-worthy gap #5: no test pinned real tokenizer behavior per provider.
 * These tests verify the routing logic and the exact-vs-heuristic contract
 * without requiring live provider endpoints (HTTP calls are mocked).
 */
import {
  AnthropicTokenCounter,
  CachedTokenCounter,
  HeuristicTokenCounter,
  HEURISTIC_CHARS_PER_TOKEN,
  TiktokenTokenCounter,
  VLLMHttpTokenCounter,
  createTokenCounter,
} from '../../../src/core/llm/tokenizer';

describe('HeuristicTokenCounter', () => {
  it('overcounts using the 3-chars-per-token divisor', async () => {
    const counter = new HeuristicTokenCounter();
    expect(HEURISTIC_CHARS_PER_TOKEN).toBe(3);
    expect(await counter.countTokens('abc')).toBe(1);
    expect(await counter.countTokens('abcd')).toBe(2);
    expect(await counter.countTokens('')).toBe(0);
  });

  it('is the fallback of last resort, not the primary path', async () => {
    // Documents the contract: heuristic exists only when no provider
    // tokenizer is reachable. Accurate counters must be preferred.
    const counter = new HeuristicTokenCounter();
    const text = 'Hello, world!';
    const count = await counter.countTokens(text);
    expect(count).toBe(Math.ceil(text.length / 3));
  });
});

describe('VLLMHttpTokenCounter', () => {
  const baseUrl = 'https://vllm.example.com/v1';
  const modelId = 'deepseek-v4-flash-vision-exp';

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the /tokenize endpoint and returns the exact count', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ count: 42, max_model_len: 131072 }),
    });

    const counter = new VLLMHttpTokenCounter({ baseUrl, modelId, apiKey: 'key', headers: {} });
    expect(await counter.countTokens('Hello, world!')).toBe(42);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/tokenize'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the endpoint is unreachable so callers can fall back', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

    const counter = new VLLMHttpTokenCounter({ baseUrl, modelId, apiKey: 'key', headers: {} });
    await expect(counter.countTokens('Hello')).rejects.toThrow();
  });
});

describe('TiktokenTokenCounter', () => {
  it('counts tokens for a known OpenAI model', async () => {
    const counter = new TiktokenTokenCounter('gpt-4o-mini');
    const count = await counter.countTokens('Hello, world!');
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('throws for unknown model ids so the composite can fall through', async () => {
    const counter = new TiktokenTokenCounter('deepseek-v4-flash-vision-exp');
    await expect(counter.countTokens('Hello')).rejects.toThrow(/unknown model/i);
  });
});

describe('AnthropicTokenCounter', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the count_tokens API and returns the input token count', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ input_tokens: 17 }),
    });

    const counter = new AnthropicTokenCounter({
      modelId: 'claude-opus-4-6',
      apiKey: 'key',
      headers: {},
    });
    expect(await counter.countTokens('Hello, world!')).toBe(17);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('count_tokens'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('CachedTokenCounter', () => {
  it('caches results for repeated texts', async () => {
    const inner = { countTokens: jest.fn().mockResolvedValue(10) };
    const counter = new CachedTokenCounter(inner);

    const longText = 'x'.repeat(2000);
    expect(await counter.countTokens(longText)).toBe(10);
    expect(await counter.countTokens(longText)).toBe(10);
    expect(inner.countTokens).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache for short texts', async () => {
    const inner = { countTokens: jest.fn().mockResolvedValue(5) };
    const counter = new CachedTokenCounter(inner);

    await counter.countTokens('short');
    await counter.countTokens('short');
    expect(inner.countTokens).toHaveBeenCalledTimes(2);
  });
});

describe('createTokenCounter routing', () => {
  it('returns tiktoken counter for OpenAI without baseUrl', () => {
    const counter = createTokenCounter({
      providerType: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'key',
      headers: {},
    });
    expect(counter).toBeInstanceOf(TiktokenTokenCounter);
  });

  it('returns OpenAI-compatible composite for OpenAI type with baseUrl', () => {
    const counter = createTokenCounter({
      providerType: 'openai',
      modelId: 'deepseek-v4-flash-vision-exp',
      baseUrl: 'https://vllm.example.com/v1',
      apiKey: 'key',
      headers: {},
    });
    // Composite tries tiktoken first, falls through to /tokenize on unknown model.
    expect(counter).not.toBeInstanceOf(HeuristicTokenCounter);
    expect(counter).not.toBeInstanceOf(TiktokenTokenCounter);
  });

  it('returns Anthropic counter for anthropic provider', () => {
    const counter = createTokenCounter({
      providerType: 'anthropic',
      modelId: 'claude-opus-4-6',
      apiKey: 'key',
      headers: {},
    });
    expect(counter).toBeInstanceOf(AnthropicTokenCounter);
  });

  it('returns heuristic when no tokenizer is available', () => {
    const counter = createTokenCounter({
      providerType: 'unknown-provider' as never,
      modelId: 'some-model',
      apiKey: 'key',
      headers: {},
    });
    expect(counter).toBeInstanceOf(HeuristicTokenCounter);
  });
});
