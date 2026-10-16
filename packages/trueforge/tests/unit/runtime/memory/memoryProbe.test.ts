import { HindsightClient } from '../../../../src/runtime/memory/hindsightClient';
import {
  MEMORY_PROBE_QUERY,
  checkMemoryProviderUrl,
  probeMemoryProvider,
} from '../../../../src/runtime/memory/memoryProbe';
import { startInertMcpServer } from '../../../fixtures/inertMcpServer';

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

describe('redirects during the check', () => {
  it('asks fetch to hand a redirect back, and reports a 3xx as a failure that says it was not followed', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: 'https://elsewhere.example/v1/default/banks/aman/memories/recall?key=hunter2' },
      }),
    );

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: {},
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(outcome).toEqual({
      ok: false,
      code: 'http_error',
      httpStatus: 307,
      reason: 'recall returned HTTP 307, a redirect to https://elsewhere.example; redirects are not followed',
    });
  });

  it.each([301, 302, 303, 308])('treats an HTTP %i as a failure too, even without a location', async status => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status }));

    const outcome = await probeMemoryProvider({
      apiBase: 'https://hindsight.example',
      bank: 'aman',
      headers: {},
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(outcome).toEqual({
      ok: false,
      code: 'http_error',
      httpStatus: status,
      reason: `recall returned HTTP ${String(status)}, a redirect; redirects are not followed`,
    });
  });

  describe('against a provider that points at another host', () => {
    it('does not follow the redirect, though the other host would have answered', async () => {
      const provider = await startInertMcpServer();
      const elsewhere = await startInertMcpServer();
      try {
        // A 307 keeps the POST and its body, so following it would have reached a working recall route.
        provider.redirectAllTo({ to: elsewhere.origin, status: 307 });

        const outcome = await checkMemoryProviderUrl({ url: provider.memoryProviderUrl, headers: {}, timeoutMs: 5000 });

        expect(outcome).toEqual({
          ok: false,
          code: 'http_error',
          httpStatus: 307,
          reason: `recall returned HTTP 307, a redirect to ${elsewhere.origin}; redirects are not followed`,
        });
        expect(provider.requestsSeen()).toBe(1);
        expect(elsewhere.requestsSeen()).toBe(0);

        provider.redirectAllTo(undefined);
        expect(await checkMemoryProviderUrl({ url: provider.memoryProviderUrl, headers: {}, timeoutMs: 5000 })).toEqual(
          {
            ok: true,
          },
        );
      } finally {
        await provider.close();
        await elsewhere.close();
      }
    });

    it('leaves turns as they were: a client built without the option still follows it', async () => {
      const provider = await startInertMcpServer();
      const elsewhere = await startInertMcpServer();
      try {
        provider.redirectAllTo({ to: elsewhere.origin, status: 307 });
        const client = new HindsightClient({ apiBase: provider.origin, bank: 'aman', headers: {} });

        const outcome = await client.recall({
          query: MEMORY_PROBE_QUERY,
          maxTokens: 16,
          entityTokens: 16,
          queryTimestamp: new Date().toISOString(),
          timeoutMs: 5000,
        });

        expect(outcome).toMatchObject({ ok: true });
        expect(elsewhere.requestsSeen()).toBe(1);
      } finally {
        await provider.close();
        await elsewhere.close();
      }
    });
  });
});
