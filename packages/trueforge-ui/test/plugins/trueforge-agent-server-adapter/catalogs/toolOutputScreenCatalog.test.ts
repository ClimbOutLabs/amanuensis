import { describe, expect, it, vi } from 'vitest';

import { createToolOutputScreenCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/toolOutputScreenCatalog.js';

const WIRE_SETTING = { data: { enabled: true, overridden: true, default_enabled: false } };

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createToolOutputScreenCatalog', () => {
  it('GETs the setting through the supplied baseUrl, token, and fetch, mapping snake_case wire fields', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://aman.example/api/v1/settings/tool-output-screens');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return okJson(WIRE_SETTING);
    });
    const catalog = createToolOutputScreenCatalog({
      baseUrl: 'https://aman.example/',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(catalog.getToolOutputScreen()).resolves.toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('PUTs true/false/null payloads and returns the parsed setting', async () => {
    const seen: Array<{ method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: init?.method, body: init?.body === undefined ? undefined : String(init.body) });
      return okJson(WIRE_SETTING);
    });
    const catalog = createToolOutputScreenCatalog({ fetch: fetchImpl });

    await catalog.setToolOutputScreenEnabled(false);
    await catalog.setToolOutputScreenEnabled(true);
    await catalog.setToolOutputScreenEnabled(null);

    expect(seen.map(call => call.body)).toEqual([
      JSON.stringify({ enabled: false }),
      JSON.stringify({ enabled: true }),
      JSON.stringify({ enabled: null }),
    ]);
    expect(seen.every(call => call.method === 'PUT')).toBe(true);
    // Same-origin default: no Authorization header when no token is supplied.
    const getCalls = await catalog.getToolOutputScreen();
    expect(getCalls.enabled).toBe(true);
  });

  it('throws the server error message on a non-2xx response', async () => {
    const catalog = createToolOutputScreenCatalog({
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Admin access required' } }), { status: 403 }),
    });
    await expect(catalog.setToolOutputScreenEnabled(true)).rejects.toThrow('Admin access required');
  });

  it('throws on a malformed payload', async () => {
    const catalog = createToolOutputScreenCatalog({ fetch: async () => okJson({ data: { enabled: 'yes' } }) });
    await expect(catalog.getToolOutputScreen()).rejects.toThrow('unexpected tool-output screen payload');
  });
});
