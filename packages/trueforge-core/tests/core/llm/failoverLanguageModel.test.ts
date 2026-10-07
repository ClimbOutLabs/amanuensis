/**
 * Failover between two language models: retryable primary failures (endpoint down,
 * timeout, 429, 5xx) retry once on the secondary before any output exists; client
 * errors (400/401/403/404) and caller cancellation propagate unchanged.
 */
import { APICallError } from 'ai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { isFailoverRetryable, withFailover } from '../../../src/core/llm/failoverLanguageModel';
import { makeSilentLogger } from '../harnessMocks';

function apiError(options: { statusCode?: number } = {}): APICallError {
  const { statusCode } = options;
  return new APICallError({
    message: 'request failed',
    url: 'http://localhost:11434/v1/chat/completions',
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
  });
}

const generateResult: LanguageModelV4GenerateResult = {
  content: [{ type: 'text', text: 'hello' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  warnings: [],
};

const streamResult: LanguageModelV4StreamResult = {
  stream: new ReadableStream({ start: controller => controller.close() }),
};

interface ScriptedModel extends LanguageModelV4 {
  calls: { generate: number; stream: number };
}

function scriptedModel(options: {
  provider?: string;
  modelId?: string;
  doGenerate?: (callOptions: LanguageModelV4CallOptions) => PromiseLike<LanguageModelV4GenerateResult>;
  doStream?: (callOptions: LanguageModelV4CallOptions) => PromiseLike<LanguageModelV4StreamResult>;
}): ScriptedModel {
  const calls = { generate: 0, stream: 0 };
  return {
    specificationVersion: 'v4',
    provider: options.provider ?? 'fake',
    modelId: options.modelId ?? 'fake-model',
    supportedUrls: {},
    doGenerate: callOptions => {
      calls.generate += 1;
      return options.doGenerate?.(callOptions) ?? Promise.resolve(generateResult);
    },
    doStream: callOptions => {
      calls.stream += 1;
      return options.doStream?.(callOptions) ?? Promise.resolve(streamResult);
    },
    calls,
  };
}

const callOptions: LanguageModelV4CallOptions = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

describe('isFailoverRetryable', () => {
  it('retries connection failures with no status code', () => {
    expect(isFailoverRetryable(apiError())).toBe(true);
  });
  it('retries timeouts, rate limits, and server errors', () => {
    for (const statusCode of [408, 409, 429, 500, 502, 503]) {
      expect(isFailoverRetryable(apiError({ statusCode }))).toBe(true);
    }
  });
  it('does not retry client errors, so bad keys and model ids surface loudly', () => {
    for (const statusCode of [400, 401, 403, 404]) {
      expect(isFailoverRetryable(apiError({ statusCode }))).toBe(false);
    }
  });
  it('retries non-API errors such as fetch TypeErrors', () => {
    expect(isFailoverRetryable(new TypeError('fetch failed'))).toBe(true);
  });
  it('never retries caller cancellation', () => {
    const aborted = new DOMException('aborted', 'AbortError');
    expect(isFailoverRetryable(aborted)).toBe(false);
  });
});

describe('withFailover', () => {
  it('uses the primary when it succeeds and never touches the secondary', async () => {
    const primary = scriptedModel({});
    const secondary = scriptedModel({});
    const wrapped = withFailover({ primary, secondary, logger: makeSilentLogger() });
    expect(await wrapped.doGenerate(callOptions)).toBe(generateResult);
    expect(primary.calls.generate).toBe(1);
    expect(secondary.calls.generate).toBe(0);
    expect(wrapped.provider).toBe('fake');
    expect(wrapped.modelId).toBe('fake-model');
    expect(wrapped.specificationVersion).toBe('v4');
  });

  it('falls over to the secondary when the primary is down, for generate and stream', async () => {
    const fallbackCalls: unknown[] = [];
    const primary = scriptedModel({
      doGenerate: () => Promise.reject(apiError()),
      doStream: () => Promise.reject(new TypeError('fetch failed')),
    });
    const secondary = scriptedModel({});
    const wrapped = withFailover({
      primary,
      secondary,
      logger: makeSilentLogger(),
      onFallback: error => fallbackCalls.push(error),
    });
    expect(await wrapped.doGenerate(callOptions)).toBe(generateResult);
    expect(await wrapped.doStream(callOptions)).toBe(streamResult);
    expect(primary.calls.generate).toBe(1);
    expect(secondary.calls.generate).toBe(1);
    expect(primary.calls.stream).toBe(1);
    expect(secondary.calls.stream).toBe(1);
    expect(fallbackCalls).toHaveLength(2);
  });

  it('does not fall over on authentication errors', async () => {
    const primary = scriptedModel({ doGenerate: () => Promise.reject(apiError({ statusCode: 401 })) });
    const secondary = scriptedModel({});
    const wrapped = withFailover({ primary, secondary, logger: makeSilentLogger() });
    await expect(wrapped.doGenerate(callOptions)).rejects.toThrow(APICallError);
    expect(secondary.calls.generate).toBe(0);
  });

  it('does not fall over when the caller already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = scriptedModel({ doGenerate: () => Promise.reject(apiError()) });
    const secondary = scriptedModel({});
    const wrapped = withFailover({ primary, secondary, logger: makeSilentLogger() });
    await expect(wrapped.doGenerate({ ...callOptions, abortSignal: controller.signal })).rejects.toThrow(APICallError);
    expect(secondary.calls.generate).toBe(0);
  });

  it('does not fall over when cancellation lands while the primary is failing', async () => {
    const controller = new AbortController();
    const primary = scriptedModel({
      doGenerate: () => {
        controller.abort();
        return Promise.reject(apiError());
      },
    });
    const secondary = scriptedModel({});
    const wrapped = withFailover({ primary, secondary, logger: makeSilentLogger() });
    await expect(wrapped.doGenerate({ ...callOptions, abortSignal: controller.signal })).rejects.toThrow(APICallError);
    expect(secondary.calls.generate).toBe(0);
  });

  it('propagates the secondary error when both endpoints are down', async () => {
    const primary = scriptedModel({ doGenerate: () => Promise.reject(apiError({ statusCode: 503 })) });
    const secondaryError = apiError({ statusCode: 500 });
    const secondary = scriptedModel({ doGenerate: () => Promise.reject(secondaryError) });
    const wrapped = withFailover({ primary, secondary, logger: makeSilentLogger() });
    await expect(wrapped.doGenerate(callOptions)).rejects.toBe(secondaryError);
  });

  it('works without a logger or callback', async () => {
    const primary = scriptedModel({ doGenerate: () => Promise.reject(apiError()) });
    const secondary = scriptedModel({});
    const wrapped = withFailover({ primary, secondary });
    expect(await wrapped.doGenerate(callOptions)).toBe(generateResult);
  });
});
