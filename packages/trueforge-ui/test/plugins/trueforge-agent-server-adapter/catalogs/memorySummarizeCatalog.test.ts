import { describe, expect, it, vi } from 'vitest';

import { createMemorySummarizeCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memorySummarizeCatalog.js';

const WIRE_SETTING = { data: { enabled: true, overridden: true, default_enabled: false, effective_enabled: true } };

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createMemorySummarizeCatalog', () => {
  it('GETs the setting through the supplied baseUrl, token, and fetch, mapping snake_case wire fields', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://aman.example/api/v1/settings/memory-summarize');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return okJson(WIRE_SETTING);
    });
    const catalog = createMemorySummarizeCatalog({
      baseUrl: 'https://aman.example/',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(catalog.getMemorySummarize()).resolves.toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: false,
      effectiveEnabled: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('PUTs true/false/null payloads and returns the parsed setting', async () => {
    const seen: Array<{ method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: init?.method, body: init?.body === undefined ? undefined : String(init.body) });
      return okJson(WIRE_SETTING);
    });
    const catalog = createMemorySummarizeCatalog({ fetch: fetchImpl });

    await catalog.setMemorySummarizeEnabled(false);
    await catalog.setMemorySummarizeEnabled(true);
    await catalog.setMemorySummarizeEnabled(null);

    expect(seen.map(call => call.body)).toEqual([
      JSON.stringify({ enabled: false }),
      JSON.stringify({ enabled: true }),
      JSON.stringify({ enabled: null }),
    ]);
    expect(seen.every(call => call.method === 'PUT')).toBe(true);
    // Same-origin default: no Authorization header when no token is supplied.
    const getCalls = await catalog.getMemorySummarize();
    expect(getCalls.enabled).toBe(true);
  });

  it('carries effective_enabled through, even when the backend gate blocks', async () => {
    const catalog = createMemorySummarizeCatalog({
      fetch: async () =>
        okJson({ data: { enabled: true, overridden: true, default_enabled: true, effective_enabled: false } }),
    });
    await expect(catalog.getMemorySummarize()).resolves.toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: true,
      effectiveEnabled: false,
    });
  });

  it('throws the server error message on a non-2xx response', async () => {
    const catalog = createMemorySummarizeCatalog({
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Admin access required' } }), { status: 403 }),
    });
    await expect(catalog.setMemorySummarizeEnabled(true)).rejects.toThrow('Admin access required');
  });

  it('throws on a malformed payload', async () => {
    const catalog = createMemorySummarizeCatalog({ fetch: async () => okJson({ data: { enabled: 'yes' } }) });
    await expect(catalog.getMemorySummarize()).rejects.toThrow('unexpected turn-summarization payload');
  });
});
