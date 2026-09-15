import {
  MEMORY_PROBE_QUERY,
  checkMemoryProviderUrl,
  probeMemoryProvider,
} from '../../../../src/runtime/memory/memoryProbe';

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { 'content-length': String(Buffer.byteLength(text, 'utf8')), 'content-type': 'application/json' },
  });
}

describe('probeMemoryProvider', () => {
  it('reports ok and dials the REST recall endpoint the turn path uses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ results: [], entities: {} }));

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: { Authorization: 'Bearer good-key' },
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true });
    const [url, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hindsight.example/v1/default/banks/aman/memories/recall');
    expect((requestInit.headers as Record<string, string>)['Authorization']).toBe('Bearer good-key');
    const body = JSON.parse(String(requestInit.body)) as { query: string; max_tokens: number };
    expect(body.query).toBe(MEMORY_PROBE_QUERY);
    // Smallest sensible budget: nothing is read out of the answer.
    expect(body.max_tokens).toBeLessThanOrEqual(32);
  });

  it('surfaces the upstream status and detail when the REST API rejects the credential', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'Authentication failed: Invalid API key' }, { status: 401 }));

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: { Authorization: 'Bearer mcp-only-key' },
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toEqual({
      ok: false,
      code: 'http_error',
      httpStatus: 401,
      detail: 'Authentication failed: Invalid API key',
      reason: 'recall returned HTTP 401: Authentication failed: Invalid API key',
    });
  });

  it('reports the authorization degradation distinctly, without dialing the provider', async () => {
    const fetchImpl = jest.fn();
    const headers = jest.fn().mockResolvedValue({ authRequired: { servers: [] } });

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers,
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: false, code: 'auth_required', reason: 'connector requires authorization' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an unreachable provider rather than throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: {},
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'request_failed' });
  });
});

describe('checkMemoryProviderUrl', () => {
  it('checks the REST API behind a single-bank MCP URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ results: [] }));

    const outcome = await checkMemoryProviderUrl({
      url: 'https://hindsight.example/mcp/aman/',
      headers: {},
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe('https://hindsight.example/v1/default/banks/aman/memories/recall');
  });

  it('rejects a URL memory could never use, without dialing anything', async () => {
    const fetchImpl = jest.fn();

    const outcome = await checkMemoryProviderUrl({
      url: 'https://hindsight.example/sse',
      headers: {},
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
