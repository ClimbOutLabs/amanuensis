import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { createMemoryPagesCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';

const PAGE = {
  kind: 'person',
  slug: 'wendy',
  title: 'Wendy',
  other_names: ['my wife'],
  summary: null,
  sections: [
    {
      name: 'Unconfirmed',
      lines: [
        {
          id: 'f_03',
          text: 'Might travel.',
          source: 'read_content',
          source_label: 'Something Aman read',
          own: false,
          since: null,
          until: null,
          seen: '2026-10-29',
        },
      ],
    },
  ],
  markdown: '---\n---\n',
  confirmable_sections: ['Now'],
  version: 'v1',
};

describe('createMemoryPagesCatalog', () => {
  it('calls each route with its method, path and body and reads the answers', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname + url.search, method, body });
      if (url.pathname.endsWith('/changes') && method === 'GET') {
        return Response.json({
          data: {
            available: true,
            changes: [{ id: 'a'.repeat(40), changed_at: 't', message: 'm', pages: [], undo_blocked_by: 'x' }],
          },
        });
      }
      if (url.pathname.endsWith('/undo') || method === 'DELETE') {
        return Response.json({ data: {} });
      }
      if (url.pathname === '/api/v1/memory/pages') {
        return Response.json({
          data: {
            pages: [
              {
                kind: 'person',
                slug: 'wendy',
                title: 'Wendy',
                other_names: [],
                summary: null,
                changed_on: '2026-11-01',
                unconfirmed_count: 2,
              },
            ],
            skipped_files: ['people/Bob.md'],
          },
        });
      }
      return Response.json({ data: PAGE });
    });
    const catalog = createMemoryPagesCatalog({ fetch: fetchStub });

    const listing = await catalog.listPages('persona:Ada');
    assert.equal(listing.pages[0]?.unconfirmedCount, 2);
    assert.deepEqual(listing.skippedFiles, ['people/Bob.md']);
    const page = await catalog.getPage({ kind: 'person', slug: 'wendy' });
    assert.equal(page.sections[0]?.lines[0]?.sourceLabel, 'Something Aman read');
    assert.deepEqual(page.confirmableSections, ['Now']);
    await catalog.savePage({ kind: 'person', slug: 'wendy', markdown: 'x', version: 'v1' });
    await catalog.confirmLine({ kind: 'person', slug: 'wendy', factId: 'f_03', section: 'Now' });
    await catalog.dismissLine({ kind: 'person', slug: 'wendy', factId: 'f_03', namespace: 'persona:Ada' });
    await catalog.deletePage({ kind: 'person', slug: 'wendy' });
    const changes = await catalog.listChanges();
    assert.equal(changes.changes[0]?.undoBlockedBy, 'x');
    await catalog.undoChange({ changeId: 'a'.repeat(40) });

    assert.deepEqual(calls, [
      { path: '/api/v1/memory/pages?namespace=persona%3AAda', method: 'GET', body: undefined },
      { path: '/api/v1/memory/pages/person/wendy', method: 'GET', body: undefined },
      { path: '/api/v1/memory/pages/person/wendy', method: 'PUT', body: { markdown: 'x', version: 'v1' } },
      { path: '/api/v1/memory/pages/person/wendy/lines/f_03/confirm', method: 'POST', body: { section: 'Now' } },
      {
        path: '/api/v1/memory/pages/person/wendy/lines/f_03/dismiss?namespace=persona%3AAda',
        method: 'POST',
        body: {},
      },
      { path: '/api/v1/memory/pages/person/wendy', method: 'DELETE', body: undefined },
      { path: '/api/v1/memory/pages/changes', method: 'GET', body: undefined },
      { path: `/api/v1/memory/pages/changes/${'a'.repeat(40)}/undo`, method: 'POST', body: {} },
    ]);
  });

  it('throws the server’s own message on a refusal', async () => {
    const catalog = createMemoryPagesCatalog({
      fetch: async () => Response.json({ error: { message: 'Reload the page.' } }, { status: 409 }),
    });
    await assert.rejects(catalog.savePage({ kind: 'person', slug: 'wendy', markdown: 'x', version: 'v' }), {
      message: 'Reload the page.',
    });
  });
});
