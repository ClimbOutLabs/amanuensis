import { declaredSearchProviderTools } from '../../../src/core/search/searchProviderTools';

/**
 * Finding 4: the search declaration is captured from the server's own tool list when the
 * person designates it. The server here is invented: no preset and no list anywhere names
 * its tools, so the split can only come from what the tools themselves declare.
 */
describe('declaredSearchProviderTools', () => {
  it('splits an invented server’s read-only, open-world tools by the page address their schema takes', () => {
    const declaration = declaredSearchProviderTools([
      {
        name: 'moon_search',
        inputSchema: { properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: 'moon_fetch',
        inputSchema: { properties: { urls: { type: 'array' }, depth: { type: 'number' } } },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      {
        name: 'moon_open',
        inputSchema: { properties: { url: { type: 'string' } } },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
    ]);
    expect(declaration.search_tools).toEqual(['moon_search']);
    expect(declaration.page_read_tools).toEqual(['moon_fetch', 'moon_open']);
  });

  it('captures nothing the server does not declare read-only, however its name reads', () => {
    const declaration = declaredSearchProviderTools([
      { name: 'web_search', inputSchema: { properties: { query: { type: 'string' } } }, annotations: {} },
      {
        name: 'web_fetch',
        inputSchema: { properties: { urls: { type: 'array' } } },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      { name: 'moon_search', inputSchema: { properties: { query: { type: 'string' } } } },
    ]);
    expect(declaration.search_tools).toEqual([]);
    expect(declaration.page_read_tools).toEqual([]);
  });

  it('captures no read-only tool the server keeps closed-world or leaves undeclared as open-world', () => {
    const declaration = declaredSearchProviderTools([
      {
        name: 'moon_memory_search',
        inputSchema: { properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'moon_echo',
        inputSchema: { properties: { text: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
    ]);
    expect(declaration.search_tools).toEqual([]);
    expect(declaration.page_read_tools).toEqual([]);
  });

  it('reads a read-only, open-world tool with no schema as a search tool, since it takes no page address', () => {
    const declaration = declaredSearchProviderTools([
      { name: 'moon_search', annotations: { readOnlyHint: true, openWorldHint: true } },
    ]);
    expect(declaration.search_tools).toEqual(['moon_search']);
    expect(declaration.page_read_tools).toEqual([]);
  });
});
