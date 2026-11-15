import {
  OutboundRedirectRefusedError,
  isOutboundBodyTimeout,
  isRetryableOutboundTransportError,
  withCheckedRedirects,
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
  it('retries a connect timeout', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('finds the timeout code nested under a fetch failure', () => {
    expect(isRetryableOutboundTransportError(fetchFailedWith('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('does not retry a headers timeout: the server has the request and is only slow', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_HEADERS_TIMEOUT'))).toBe(false);
  });

  it('does not retry other transport failures', () => {
    expect(isRetryableOutboundTransportError(codedError('UND_ERR_BODY_TIMEOUT'))).toBe(false);
    expect(isRetryableOutboundTransportError(new Error('boom'))).toBe(false);
  });
});

describe('isOutboundBodyTimeout', () => {
  it('reads the undici code through a fetch failure', () => {
    expect(isOutboundBodyTimeout(fetchFailedWith('UND_ERR_BODY_TIMEOUT'))).toBe(true);
  });

  it('reads the undici text when the MCP SDK has dropped the cause', () => {
    expect(isOutboundBodyTimeout(new Error('SSE stream disconnected: BodyTimeoutError: Body Timeout Error'))).toBe(
      true,
    );
  });

  it('does not match another failure', () => {
    expect(isOutboundBodyTimeout(fetchFailedWith('UND_ERR_HEADERS_TIMEOUT'))).toBe(false);
    expect(isOutboundBodyTimeout(new Error('SSE stream disconnected: socket hang up'))).toBe(false);
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

  it('does not retry a headers timeout for a model request either, so a slow model is not asked twice', async () => {
    const { fetchFn, calls } = scriptedFetch([fetchFailedWith('UND_ERR_HEADERS_TIMEOUT'), response(200)]);
    await expect(withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {})).rejects.toThrow(
      'fetch failed',
    );
    expect(calls()).toBe(1);
  });

  it('returns the answer at once when Retry-After asks for a longer wait than the cap', async () => {
    const { fetchFn, calls } = scriptedFetch([response(429, { 'retry-after': '30' }), response(200)]);
    const started = Date.now();
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {});
    expect(result.status).toBe(429);
    expect(calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('stops waiting and rejects when the caller aborts during the backoff', async () => {
    const { fetchFn, calls } = scriptedFetch([response(429), response(200)]);
    const controller = new AbortController();
    const pending = withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {
      signal: controller.signal,
    });
    // The backoff after the 429 is about a second; abort well inside it.
    setTimeout(() => {
      controller.abort();
    }, 50);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls()).toBe(1);
  });

  it('buffers a streamed request body once so the retry sends the same bytes', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetchFn = jest.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      bodies.push(await new Response(init?.body ?? null).text());
      return calls === 1 ? response(429, { 'retry-after-ms': '0' }) : response(200);
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":'));
        controller.enqueue(new TextEncoder().encode('"hello"}'));
        controller.close();
      },
    });
    const result = await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', {
      method: 'POST',
      body: stream,
    });
    expect(result.status).toBe(200);
    expect(bodies).toEqual(['{"prompt":"hello"}', '{"prompt":"hello"}']);
  });

  it('leaves a string body as it is', async () => {
    const seen: Array<RequestInit['body']> = [];
    const fetchFn = jest.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push(init?.body);
      return response(200);
    });
    await withOutboundHttpRetries(fetchFn, MODEL_OPTIONS)('https://model.example/v1', { method: 'POST', body: 'x' });
    expect(seen).toEqual(['x']);
  });

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

describe('withCheckedRedirects', () => {
  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  /** A base fetch that answers from a table keyed by URL and records the URLs and inits it saw. */
  function urlFetch(routes: Record<string, Response>): {
    fetchFn: jest.Mock;
    seen: string[];
    inits: Array<RequestInit | undefined>;
  } {
    const seen: string[] = [];
    const inits: Array<RequestInit | undefined> = [];
    const fetchFn = jest.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      seen.push(url);
      inits.push(init);
      const route = routes[url];
      if (route === undefined) {
        throw new Error(`no scripted route for ${url}`);
      }
      return route;
    });
    return { fetchFn, seen, inits };
  }

  it('returns a non-redirect answer untouched, without asking the check', async () => {
    const { fetchFn, seen } = urlFetch({ 'https://model.example/v1': response(200) });
    const check = jest.fn(async (): Promise<boolean> => true);
    const result = await withCheckedRedirects(fetchFn, check)('https://model.example/v1', {});
    expect(result.status).toBe(200);
    expect(seen).toEqual(['https://model.example/v1']);
    expect(check).not.toHaveBeenCalled();
  });

  it('follows a redirect the check passes, asking about the target before dialling it', async () => {
    const { fetchFn, seen } = urlFetch({
      'https://model.example/v1': redirectTo('https://models.other.example/v1'),
      'https://models.other.example/v1': response(200),
    });
    const checked: string[] = [];
    const check = async (url: string): Promise<boolean> => {
      checked.push(url);
      return true;
    };
    const result = await withCheckedRedirects(fetchFn, check)('https://model.example/v1', {});
    expect(result.status).toBe(200);
    expect(checked).toEqual(['https://models.other.example/v1']);
    expect(seen).toEqual(['https://model.example/v1', 'https://models.other.example/v1']);
  });

  it('refuses a redirect the check fails, and never dials the target', async () => {
    const { fetchFn, seen } = urlFetch({
      'https://model.example/v1': redirectTo('http://169.254.169.254/latest/meta-data'),
      'http://169.254.169.254/latest/meta-data': response(200),
    });
    const check = async (): Promise<boolean> => false;
    await expect(withCheckedRedirects(fetchFn, check)('https://model.example/v1', {})).rejects.toBeInstanceOf(
      OutboundRedirectRefusedError,
    );
    expect(seen).toEqual(['https://model.example/v1']);
  });

  it('turns a POST into a bodiless GET on a 302, and replays it as sent on a 307', async () => {
    const post = { method: 'POST', body: '{"prompt":"hi"}' };
    const moved = urlFetch({
      'https://model.example/v1': redirectTo('https://model.example/v2', 302),
      'https://model.example/v2': response(200),
    });
    await withCheckedRedirects(moved.fetchFn, async () => true)('https://model.example/v1', post);
    expect(moved.inits[1]?.method).toBe('GET');
    expect(moved.inits[1]?.body).toBeNull();

    const kept = urlFetch({
      'https://model.example/v1': redirectTo('https://model.example/v2', 307),
      'https://model.example/v2': response(200),
    });
    await withCheckedRedirects(kept.fetchFn, async () => true)('https://model.example/v1', post);
    expect(kept.inits[1]?.method).toBe('POST');
    expect(kept.inits[1]?.body).toBe('{"prompt":"hi"}');
  });

  it('drops the credential headers on a 307 to another origin, and keeps them on one within the origin', async () => {
    const sent = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer PROVIDER-KEY',
        Cookie: 'session=person-session',
        'X-Api-Key': 'provider-key-header',
        'Api-Key': 'provider-key-alt-header',
      },
      body: '{"prompt":"hi"}',
    };

    const crossed = urlFetch({
      'https://model.example/v1': redirectTo('https://models.other.example/v1', 307),
      'https://models.other.example/v1': response(200),
    });
    await withCheckedRedirects(crossed.fetchFn, async () => true)('https://model.example/v1', sent);
    // The first dial carries the credentials, as the caller sent them; the other origin sees none of them.
    expect(new Headers(crossed.inits[0]?.headers).get('authorization')).toBe('Bearer PROVIDER-KEY');
    const crossedTarget = new Headers(crossed.inits[1]?.headers);
    expect(crossedTarget.get('authorization')).toBeNull();
    expect(crossedTarget.get('cookie')).toBeNull();
    expect(crossedTarget.get('x-api-key')).toBeNull();
    expect(crossedTarget.get('api-key')).toBeNull();

    const within = urlFetch({
      'https://model.example/v1': redirectTo('https://model.example/v2', 307),
      'https://model.example/v2': response(200),
    });
    await withCheckedRedirects(within.fetchFn, async () => true)('https://model.example/v1', sent);
    const withinTarget = new Headers(within.inits[1]?.headers);
    expect(withinTarget.get('authorization')).toBe('Bearer PROVIDER-KEY');
    expect(withinTarget.get('cookie')).toBe('session=person-session');
    expect(withinTarget.get('x-api-key')).toBe('provider-key-header');
    expect(withinTarget.get('api-key')).toBe('provider-key-alt-header');
  });

  it('stops a redirect chain that never ends', async () => {
    let calls = 0;
    const fetchFn = jest.fn(async (input: string | URL): Promise<Response> => {
      calls += 1;
      return redirectTo(String(input).endsWith('/a') ? 'https://model.example/b' : 'https://model.example/a');
    });
    await expect(withCheckedRedirects(fetchFn, async () => true)('https://model.example/a', {})).rejects.toMatchObject({
      name: 'OutboundRedirectRefusedError',
      message: expect.stringContaining('kept redirecting'),
    });
    expect(calls).toBe(6);
  });

  it('refuses a redirect that names no usable address', async () => {
    const { fetchFn } = urlFetch({ 'https://model.example/v1': new Response(null, { status: 302 }) });
    await expect(
      withCheckedRedirects(fetchFn, async () => true)('https://model.example/v1', {}),
    ).rejects.toBeInstanceOf(OutboundRedirectRefusedError);
  });
});
