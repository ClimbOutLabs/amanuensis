import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { createMemoryPagesCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryPagesCatalog.js';

const PAGE = {
  kind: 'person',
  slug: 'nora',
  title: 'Nora',
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
          source_label: 'External source: read content',
          own: false,
          since: null,
          until: null,
          seen: '2026-10-29',
        },
      ],
    },
  ],
  text: '# Nora\n',
  confirmable_sections: ['Now'],
  version: 'v1',
  disagreements: [
    {
      id: 'p1',
      first: { id: 'f_01', text: 'Plays tennis.' },
      second: { id: 'f_03', text: 'Never plays sport.' },
      reason: 'One says she plays.',
      found_on: '2026-11-11',
    },
  ],
};

describe('createMemoryPagesCatalog', () => {
  it('calls each route with its method, path and body and reads the answers', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname + url.search, method, body });
      if (method === 'DELETE') {
        return Response.json({ data: {} });
      }
      if (url.pathname === '/api/v1/memory/pages') {
        return Response.json({
          data: {
            pages: [
              {
                kind: 'person',
                slug: 'nora',
                title: 'Nora',
                other_names: [],
                summary: null,
                changed_on: '2026-11-01',
                disagreement_count: 1,
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
    assert.equal(listing.pages[0]?.disagreementCount, 1);
    assert.deepEqual(listing.skippedFiles, ['people/Bob.md']);
    const page = await catalog.getPage({ kind: 'person', slug: 'nora' });
    assert.equal(page.sections[0]?.lines[0]?.sourceLabel, 'External source: read content');
    assert.deepEqual(page.confirmableSections, ['Now']);
    assert.equal(page.disagreements[0]?.foundOn, '2026-11-11');
    await catalog.savePage({ kind: 'person', slug: 'nora', text: 'x', version: 'v1' });
    await catalog.confirmLine({ kind: 'person', slug: 'nora', factId: 'f_03', section: 'Now' });
    await catalog.dismissLine({ kind: 'person', slug: 'nora', factId: 'f_03', namespace: 'persona:Ada' });
    await catalog.dismissDisagreement({ kind: 'person', slug: 'nora', disagreementId: 'p1' });
    await catalog.deletePage({ kind: 'person', slug: 'nora' });

    assert.deepEqual(calls, [
      { path: '/api/v1/memory/pages?namespace=persona%3AAda', method: 'GET', body: undefined },
      { path: '/api/v1/memory/pages/person/nora', method: 'GET', body: undefined },
      { path: '/api/v1/memory/pages/person/nora', method: 'PUT', body: { text: 'x', version: 'v1' } },
      { path: '/api/v1/memory/pages/person/nora/lines/f_03/confirm', method: 'POST', body: { section: 'Now' } },
      {
        path: '/api/v1/memory/pages/person/nora/lines/f_03/dismiss?namespace=persona%3AAda',
        method: 'POST',
        body: {},
      },
      { path: '/api/v1/memory/pages/person/nora/disagreements/p1/dismiss', method: 'POST', body: {} },
      { path: '/api/v1/memory/pages/person/nora', method: 'DELETE', body: undefined },
    ]);
  });

  it('throws the server’s own message on a refusal', async () => {
    const catalog = createMemoryPagesCatalog({
      fetch: async () => Response.json({ error: { message: 'Reload the page.' } }, { status: 409 }),
    });
    await assert.rejects(catalog.savePage({ kind: 'person', slug: 'nora', text: 'x', version: 'v' }), {
      message: 'Reload the page.',
    });
  });
});
