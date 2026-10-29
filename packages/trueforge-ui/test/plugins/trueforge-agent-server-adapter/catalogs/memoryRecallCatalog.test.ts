import { describe, expect, it, vi } from 'vitest';

import { createMemoryRecallCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryRecallCatalog.js';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createMemoryRecallCatalog', () => {
  it('reads the switch through the supplied base URL, token, and fetch', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://host.example/api/v1/settings/memory-recall');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return okJson({ data: { enabled: false } });
    });
    const catalog = createMemoryRecallCatalog({ baseUrl: 'https://host.example/', token: 'secret', fetch: fetchImpl });
    await expect(catalog.getMemoryRecall()).resolves.toEqual({ enabled: false });
  });

  it('reads an unset switch as null', async () => {
    const catalog = createMemoryRecallCatalog({ fetch: async () => okJson({ data: { enabled: null } }) });
    await expect(catalog.getMemoryRecall()).resolves.toEqual({ enabled: null });
  });

  it('writes true, false, and null', async () => {
    const bodies: string[] = [];
    const catalog = createMemoryRecallCatalog({
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return okJson({ data: { enabled: null } });
      },
    });
    await catalog.setMemoryRecallEnabled(false);
    await catalog.setMemoryRecallEnabled(true);
    await catalog.setMemoryRecallEnabled(null);
    expect(bodies).toEqual([
      JSON.stringify({ enabled: false }),
      JSON.stringify({ enabled: true }),
      JSON.stringify({ enabled: null }),
    ]);
  });

  it('turns a server error into its message', async () => {
    const catalog = createMemoryRecallCatalog({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Ask an admin to change this.' } }), { status: 403 }),
    });
    await expect(catalog.setMemoryRecallEnabled(false)).rejects.toThrow('Ask an admin to change this.');
  });

  it('rejects an unexpected body with a next step', async () => {
    const catalog = createMemoryRecallCatalog({ fetch: async () => okJson({ data: {} }) });
    await expect(catalog.getMemoryRecall()).rejects.toThrow(/Reload the page/);
  });
});
