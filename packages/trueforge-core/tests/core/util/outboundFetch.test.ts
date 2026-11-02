import {
  isRetryableOutboundTransportError,
  withOutboundHttpRetries,
  type OutboundFetchOptions,
} from '../../../src/core/util/outboundFetch';

const MODEL_OPTIONS: OutboundFetchOptions = {
  connectTimeoutMs: 5_000,
  headersTimeoutMs: 5_000,
  bodyTimeoutMs: 5_000,
  maxRetries: 2,
  idempotent: true,
};

const MCP_OPTIONS: OutboundFetchOptions = { ...MODEL_OPTIONS, idempotent: false };

function codedError(code: string): Error {
  const error = new Error(`undici ${code}`);
  Reflect.set(error, 'code', code);
  return error;
}

/** The fetch layer reports a bare "fetch failed" and hides the coded reason on the cause. */
function fetchFailedWith(code: string): Error {
  return new Error('fetch failed', { cause: codedError(code) });
}

function response(status: number, headers?: Record<string, string>): Response {
  return new Response('body', { status, ...(headers === undefined ? {} : { headers }) });
}

/** A base fetch that answers (or throws) the scripted outcomes in order, repeating the last. */
function scriptedFetch(outcomes: Array<Response | Error>): { fetchFn: jest.Mock; calls: () => number } {
  let calls = 0;
  const fetchFn = jest.fn(async (): Promise<Response> => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls += 1;
    if (outcome === undefined) {
      throw new Error('scripted fetch ran out of outcomes');
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  });
  return { fetchFn, calls: () => calls };
}

describe('isRetryableOutboundTransportError', () => {
  it('retries a connect timeout for any caller', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_CONNECT_TIMEOUT'), { idempotent: false })).toBe(true);
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_CONNECT_TIMEOUT'), { idempotent: true })).toBe(true);
  });

  it('finds the timeout code nested under a fetch failure', () => {
    expect(isRetryableOutboundTransportError(fetchFailedWith('UND_ERR_CONNECT_TIMEOUT'), { idempotent: false })).toBe(
      true,
    );
  });

  it('retries a headers timeout only when the request is safe to replay', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_HEADERS_TIMEOUT'), { idempotent: true })).toBe(true);
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_HEADERS_TIMEOUT'), { idempotent: false })).toBe(false);
  });

  it('does not retry other transport failures', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_BODY_TIMEOUT'), { idempotent: true })).toBe(false);
    expect(isRetryableOutboundTransportError(new Error('boom'), { idempotent: true })).toBe(false);
  });
});

describe('withOutboundHttpRetries', () => {
  it('returns the first response when it is not a retryable status', async () => {
    const { fetchFn, calls } = scriptedFetch([response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it('does not retry a status outside the retry sets', async () => {
    const { fetchFn, calls } = scriptedFetch([response(500)]);
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(500);
    expect(calls()).toBe(1);
  });

  it('retries a 429 and returns the later response, honoring Retry-After', async () => {
    const { fetchFn, calls } = scriptedFetch([response(429, { 'retry-after-ms': '0' }), response(200)]);
    const started = Date.now();
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
    // Default backoff is about a second; a much shorter wait proves Retry-After was used.
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('retries a gateway status where the origin was never reached, even for MCP', async () => {
    const { fetchFn, calls } = scriptedFetch([response(522, { 'retry-after-ms': '0' }), response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, MCP_OPTIONS)('https://mcp.example/mcp', {});
    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it('does not retry a status where upstream may have processed the request, for MCP', async () => {
    const { fetchFn, calls } = scriptedFetch([response(524, { 'retry-after-ms': '0' }), response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, MCP_OPTIONS)('https://mcp.example/mcp', {});
    expect(result.status).toBe(524);
    expect(calls()).toBe(1);
  });

  it('retries that same maybe-processed status for a replayable model request', async () => {
    const { fetchFn, calls } = scriptedFetch([response(524, { 'retry-after-ms': '0' }), response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it('stops after maxRetries and returns the last response', async () => {
    const { fetchFn, calls } = scriptedFetch([response(429, { 'retry-after-ms': '0' })]);
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(429);
    expect(calls()).toBe(3);
  });

  it('retries a connect timeout and returns the later response', async () => {
    const { fetchFn, calls } = scriptedFetch([fetchFailedWith('UND_ERR_CONNECT_TIMEOUT'), response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, { ...MCP_OPTIONS, maxRetries: 1 })(
      'https://mcp.example/mcp',
      {},
    );
    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
  }, 10_000);

  it('does not retry a headers timeout for MCP, so a long tool call is not replayed', async () => {
    const { fetchFn, calls } = scriptedFetch([fetchFailedWith('UND_ERR_HEADERS_TIMEOUT'), response(200)]);
    await expect(withOutboundHttpRetries(fetchFn, MCP_OPTIONS)('https://mcp.example/mcp', {})).rejects.toThrow(
      'fetch failed',
    );
    expect(calls()).toBe(1);
  });

  it('retries a headers timeout for a replayable model request', async () => {
    const { fetchFn, calls } = scriptedFetch([fetchFailedWith('UND_ERR_HEADERS_TIMEOUT'), response(200)]);
    const result = await withOutboundHttpRetries(fetchFn, { ...MODEL_OPTIONS, maxRetries: 1 })(
      'https://model.example/v1',
      {},
    );
    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
  }, 10_000);

  it('throws at once when the caller has already aborted', async () => {
    const { fetchFn, calls } = scriptedFetch([response(200)]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(0);
  });
});
