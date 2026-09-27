import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { createMemoryVaultCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

const ENTRY = {
  id: 'md:tenant-1:2026-09-27.md#0',
  text: 'Prefers morning meetings',
  timestamp: '2026-09-27T10:00:00.000Z',
  persona: null,
};

function fetchFor(handler: (path: string, method: string) => unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.href : String(input), 'http://localhost');
    const body = await handler(url.pathname + url.search, init?.method ?? 'GET');
    return Response.json({ data: body });
  });
}

describe('createMemoryVaultCatalog', () => {
  it('lists, updates, deletes, exports, and imports', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const catalog = createMemoryVaultCatalog({
      fetch: fetchFor((path, method) => {
        calls.push({ path, method });
        if (path === '/api/v1/memory/vault' && method === 'GET') return [ENTRY];
        if (path === '/api/v1/memory/vault?namespace=persona%3Aplanner' && method === 'GET') return [];
        if (path === '/api/v1/memory/vault/export' && method === 'GET')
          return { namespace: 'default', exported_at: '2026-09-27T12:00:00.000Z', entries: [ENTRY] };
        if (path === '/api/v1/memory/vault/import' && method === 'POST')
          return { namespace: 'default', imported: 1 };
        if (path.startsWith('/api/v1/memory/vault/') && method === 'PUT') return ENTRY;
        if (path.startsWith('/api/v1/memory/vault/') && method === 'DELETE') return {};
        throw new Error(`unexpected request ${method} ${path}`);
      }),
    });

    const listed = await catalog.listEntries();
    assert.deepEqual(listed, [ENTRY]);

    const personaListed = await catalog.listEntries('persona:planner');
    assert.deepEqual(personaListed, []);

    const updated = await catalog.updateEntry({ entryId: ENTRY.id, text: 'Evening meetings' });
    assert.equal(updated.text, 'Prefers morning meetings');

    await catalog.deleteEntry(ENTRY.id);

    const exported = await catalog.exportEntries();
    assert.equal(exported.namespace, 'default');
    assert.equal(exported.exportedAt, '2026-09-27T12:00:00.000Z');
    assert.deepEqual(exported.entries, [ENTRY]);

    const imported = await catalog.importEntries({
      entries: [{ text: 'Uses metric units' }],
    });
    assert.equal(imported.imported, 1);

    assert.ok(calls.some(call => call.method === 'PUT' && call.path.includes(encodeURIComponent(ENTRY.id))));
  });

  it('throws a readable error when the server rejects a request', async () => {
    const catalog = createMemoryVaultCatalog({
      fetch: vi.fn(async () =>
        Response.json({ error: { message: 'Entry not found' } }, { status: 404 }),
      ),
    });
    await assert.rejects(() => catalog.listEntries(), /Entry not found/);
  });

  it('throws when the server payload is malformed', async () => {
    const catalog = createMemoryVaultCatalog({
      fetch: vi.fn(async () => Response.json({ data: [{ id: 1 }] })),
    });
    await assert.rejects(() => catalog.listEntries(), /unexpected memory vault payload/);
  });
});
