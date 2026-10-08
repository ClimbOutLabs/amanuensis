import {
  AnthropicTokenCounter,
  CachedTokenCounter,
  HEURISTIC_CHARS_PER_TOKEN,
  HeuristicTokenCounter,
  TiktokenTokenCounter,
  VLLMHttpTokenCounter,
  createTokenCounter,
  type TokenCounter,
  type TokenCounterConfig,
} from '../../../src/core/llm/tokenizer';

function baseConfig(overrides: Partial<TokenCounterConfig> = {}): TokenCounterConfig {
  return {
    providerType: 'openai',
    modelId: 'gpt-4o',
    baseUrl: undefined,
    apiKey: 'test-key',
    headers: {},
    signal: undefined,
    ...overrides,
  };
}

function mockFetchJson(data: unknown, ok = true, status = 200): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('TiktokenTokenCounter', () => {
  it('returns exact tiktoken counts for gpt-4o', async () => {
    const counter = new TiktokenTokenCounter('gpt-4o');
    await expect(counter.countTokens('Hello world')).resolves.toBe(2);
    await expect(
      counter.countTokens('The quick brown fox jumps over the lazy dog'),
    ).resolves.toBe(9);
  });

  it('throws an unknown-model error for ids outside the tiktoken registry', async () => {
    const counter = new TiktokenTokenCounter('not-a-real-model-xyz');
    await expect(counter.countTokens('hello')).rejects.toThrow(/unknown model/i);
  });
});

describe('VLLMHttpTokenCounter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts to /tokenize and returns the count field', async () => {
    const fetchMock = mockFetchJson({ count: 42 });
    const counter = new VLLMHttpTokenCounter({
      baseUrl: 'http://localhost:8000/',
      modelId: 'my-model',
      apiKey: 'key',
      headers: {},
    });
    await expect(counter.countTokens('hello')).resolves.toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/tokenize');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('my-model');
  });

  it('falls back to tokens array length when count is absent', async () => {
    mockFetchJson({ tokens: [1, 2, 3, 4, 5] });
    const counter = new VLLMHttpTokenCounter({
      baseUrl: 'http://localhost:8000',
      modelId: 'my-model',
      apiKey: '',
      headers: {},
    });
    await expect(counter.countTokens('hello')).resolves.toBe(5);
  });

  it('throws on non-2xx responses', async () => {
    mockFetchJson({}, false, 500);
    const counter = new VLLMHttpTokenCounter({
      baseUrl: 'http://localhost:8000',
      modelId: 'my-model',
      apiKey: '',
      headers: {},
    });
    await expect(counter.countTokens('hello')).rejects.toThrow(/500/);
  });
});

describe('OpenAI-compatible fallthrough', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses tiktoken for known OpenAI model ids without hitting the network', async () => {
    const fetchMock = mockFetchJson({ count: 999 });
    const counter = createTokenCounter(
      baseConfig({ providerType: 'openai', modelId: 'gpt-4o', baseUrl: 'http://localhost:8000' }),
    );
    await expect(counter.countTokens('Hello world')).resolves.toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls through to /tokenize for unknown model ids on OpenAI-compatible endpoints', async () => {
    const fetchMock = mockFetchJson({ count: 17 });
    const counter = createTokenCounter(
      baseConfig({
        providerType: 'openai',
        modelId: 'deepseek-v4-flash-vision-exp',
        baseUrl: 'http://localhost:8000',
      }),
    );
    await expect(counter.countTokens('hello world')).resolves.toBe(17);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/tokenize');
  });
});

describe('AnthropicTokenCounter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts to count_tokens and returns input_tokens', async () => {
    const fetchMock = mockFetchJson({ input_tokens: 23 });
    const counter = new AnthropicTokenCounter({ modelId: 'claude-opus-4-1', apiKey: 'key' });
    await expect(counter.countTokens('hello')).resolves.toBe(23);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(init.body).toContain('claude-opus-4-1');
  });
});

describe('createTokenCounter', () => {
  it('returns AnthropicTokenCounter for anthropic providers', () => {
    const counter = createTokenCounter(baseConfig({ providerType: 'anthropic' }));
    expect(counter).toBeInstanceOf(AnthropicTokenCounter);
  });

  it('returns TiktokenTokenCounter for openai without a baseUrl', () => {
    const counter = createTokenCounter(baseConfig({ providerType: 'openai', modelId: 'gpt-4o' }));
    expect(counter).toBeInstanceOf(TiktokenTokenCounter);
  });

  it('returns the OpenAI-compatible composite for openai with a baseUrl', () => {
    const counter = createTokenCounter(
      baseConfig({ providerType: 'openai', modelId: 'gpt-4o', baseUrl: 'http://localhost:8000' }),
    );
    expect(counter).not.toBeInstanceOf(TiktokenTokenCounter);
    expect(counter).not.toBeInstanceOf(VLLMHttpTokenCounter);
    expect(counter.constructor.name).toBe('OpenAICompatibleTokenCounter');
  });

  it('returns VLLMHttpTokenCounter for other providers with a baseUrl', () => {
    const counter = createTokenCounter(
      baseConfig({ providerType: 'custom', modelId: 'my-model', baseUrl: 'http://localhost:8000' }),
    );
    expect(counter).toBeInstanceOf(VLLMHttpTokenCounter);
  });

  it('returns HeuristicTokenCounter when no baseUrl and no native tokenizer', () => {
    const counter = createTokenCounter(
      baseConfig({ providerType: 'custom', modelId: 'my-model', baseUrl: undefined }),
    );
    expect(counter).toBeInstanceOf(HeuristicTokenCounter);
  });
});

describe('HeuristicTokenCounter', () => {
  it('uses 3 chars per token', () => {
    expect(HEURISTIC_CHARS_PER_TOKEN).toBe(3);
  });

  it('computes ceil(length / 3)', async () => {
    const counter = new HeuristicTokenCounter();
    await expect(counter.countTokens('a'.repeat(10))).resolves.toBe(4);
    await expect(counter.countTokens('')).resolves.toBe(0);
    await expect(counter.countTokens('abc')).resolves.toBe(1);
  });

  it('overcounts relative to the accurate tokenizer', async () => {
    const heuristic = new HeuristicTokenCounter();
    const tiktoken = new TiktokenTokenCounter('gpt-4o');
    const text = 'Hello world';
    const [estimated, exact] = await Promise.all([
      heuristic.countTokens(text),
      tiktoken.countTokens(text),
    ]);
    expect(estimated).toBeGreaterThanOrEqual(exact);
  });
});

describe('CachedTokenCounter', () => {
  function makeInner(count: number): { inner: TokenCounter; calls: jest.Mock } {
    const calls = jest.fn().mockResolvedValue(count);
    const inner: TokenCounter = { countTokens: calls };
    return { inner, calls };
  }

  function longText(seed: string): string {
    return `${seed}-`.padEnd(1200, 'x');
  }

  it('returns the cached value without re-calling inner on a hit', async () => {
    const { inner, calls } = makeInner(7);
    const counter = new CachedTokenCounter(inner);
    const text = longText('a');
    await expect(counter.countTokens(text)).resolves.toBe(7);
    await expect(counter.countTokens(text)).resolves.toBe(7);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache for sub-1000-char strings', async () => {
    const { inner, calls } = makeInner(3);
    const counter = new CachedTokenCounter(inner);
    await expect(counter.countTokens('short')).resolves.toBe(3);
    await expect(counter.countTokens('short')).resolves.toBe(3);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry at capacity', async () => {
    const { inner, calls } = makeInner(1);
    const counter = new CachedTokenCounter(inner, 2);
    const first = longText('first');
    const second = longText('second');
    const third = longText('third');

    await counter.countTokens(first);
    await counter.countTokens(second);
    await counter.countTokens(third);

    // The first entry was evicted; counting it again re-calls inner.
    expect(calls).toHaveBeenCalledTimes(3);
    await counter.countTokens(first);
    expect(calls).toHaveBeenCalledTimes(4);
    // The third entry is still cached.
    await counter.countTokens(third);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it('caches different long strings independently', async () => {
    const calls = jest
      .fn()
      .mockImplementation((text: string) => Promise.resolve(text.length));
    const counter = new CachedTokenCounter({ countTokens: calls });
    await expect(counter.countTokens(longText('a'))).resolves.toBe(1200);
    await expect(counter.countTokens(longText('b'))).resolves.toBe(1200);
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
