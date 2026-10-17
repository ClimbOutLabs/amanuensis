import { defaultSearchConnector, isUntouchedDefaultSearchConnector } from '../../../src/catalog/defaultSearchConnector';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import type { McpServerRecord } from '../../../src/db/mcpServerStore';

const noClient = { getClient: () => Promise.resolve(undefined) };

function record(manifest: McpServerRecord['manifest']): McpServerRecord {
  return {
    id: 'row-1',
    tenant_id: 'default',
    name: manifest.name,
    manifest,
    first_party: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('defaultSearchConnector', () => {
  it("is the shipped catalog's keyless search preset with its search tools", () => {
    expect(defaultSearchConnector(McpCatalog.load())).toEqual({
      name: 'parallel-web',
      manifest: {
        type: 'remote',
        name: 'parallel-web',
        url: 'https://search.parallel.ai/mcp',
        description: 'Free web search and page fetch. No API key needed. Added as your web search provider.',
        search_provider: true,
        search_tools: ['web_search', 'web_fetch'],
      },
    });
  });

  it('is none when the only search preset needs a key, so nothing passes as untouched', async () => {
    const catalog = new McpCatalog([
      {
        type: 'remote',
        name: 'keyed-search',
        url: 'https://search.example.com/mcp',
        description: 'Needs a key.',
        auth: { type: 'header', headers: { Authorization: 'Bearer YOUR_KEY' } },
        search_provider: true,
      },
    ]);
    expect(defaultSearchConnector(catalog)).toBeUndefined();
    const stored = record({
      type: 'remote',
      name: 'keyed-search',
      url: 'https://search.example.com/mcp',
      description: 'Needs a key.',
    });
    expect(await isUntouchedDefaultSearchConnector({ record: stored, catalog, clientStore: noClient })).toBe(false);
  });

  it('matches the stored connector only when nothing about it changed', async () => {
    const catalog = McpCatalog.load();
    const seeded = defaultSearchConnector(catalog);
    if (seeded === undefined) {
      throw new Error('The shipped catalog has no keyless search preset.');
    }
    const untouched = record(seeded.manifest);
    expect(await isUntouchedDefaultSearchConnector({ record: untouched, catalog, clientStore: noClient })).toBe(true);
    const renamed = { ...untouched, name: 'my-search' };
    expect(await isUntouchedDefaultSearchConnector({ record: renamed, catalog, clientStore: noClient })).toBe(false);
  });
});
