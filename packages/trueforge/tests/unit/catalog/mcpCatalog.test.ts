import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { parseMemoryProviderUrl } from '../../../src/runtime/memory/memoryProvider';
import { McpCatalogFileSchema } from '../../../src/schemas/mcpCatalog';

describe('shipped MCP catalog', () => {
  it('loads and validates every shipped preset', () => {
    expect(McpCatalog.loadShipped().list().length).toBeGreaterThan(0);
  });

  it('ships a hindsight preset whose placeholder URL is a shape memory can actually use', () => {
    const hindsight = McpCatalog.loadShipped()
      .list()
      .find(server => server.name === 'hindsight');
    if (hindsight === undefined) {
      throw new Error('expected a hindsight preset in the shipped MCP catalog');
    }

    // The URL is a per-deployment placeholder, but it must still parse as {apiBase}/mcp/{bank}:
    // that is the only shape resolveMemoryProvider accepts, and anything else silently disables
    // memory for the turn.
    expect(parseMemoryProviderUrl(hindsight.url)).toEqual({
      apiBase: 'https://your-hindsight-host:8449',
      bank: 'your-bank',
    });
    // Hindsight authenticates with an API key in a header, not OAuth.
    expect(hindsight.auth?.type).toBe('header');
    // No hosted logo asset exists for a self-hosted server; a broken image is worse than none.
    expect(hindsight.logo).toBeUndefined();
    expect(hindsight.description).toMatch(/\{apiBase\}\/mcp\/\{bank\}/);
  });

  it('offers Parallel’s keyless hosted MCP and Tavily as the presets that can become the web search provider', () => {
    const presets = McpCatalog.loadShipped().list();
    expect(presets.filter(server => server.search_provider === true).map(server => server.name)).toEqual([
      'parallel-web',
      'tavily',
    ]);
    const parallel = presets.find(server => server.name === 'parallel-web');
    if (parallel === undefined) {
      throw new Error('expected a parallel-web preset in the shipped MCP catalog');
    }
    expect(parallel.url).toBe('https://search.parallel.ai/mcp');
    // Keyless: no credentials to ask for.
    expect(parallel.auth).toBeUndefined();
  });

  it('keeps Tavily as a preset a user can pick as the search provider, with its key asked for and no plumbing', () => {
    const catalog = McpCatalog.loadShipped();
    const tavily = catalog.list().find(server => server.name === 'tavily');
    expect(tavily?.url).toBe('https://mcp.tavily.com/mcp');
    expect(tavily?.search_provider).toBe(true);
    expect(tavily?.auth?.type).toBe('header');
    // The default seed only takes a keyless preset, so Tavily is never added on its own.
    expect(catalog.list().filter(server => server.search_provider === true && server.auth === undefined)).toHaveLength(
      1,
    );
    expect(catalog.searchProviderGrant({ url: 'https://mcp.tavily.com/mcp', storedTools: [] })).toEqual({
      tools: ['tavily_search', 'tavily_extract'],
      plumbing_fields: [],
    });
  });

  it('lists the real search tools of Parallel, Tavily and Exa, and none for a server that cannot search', () => {
    const catalog = McpCatalog.loadShipped();
    const searchTools = (name: string) => catalog.list().find(server => server.name === name)?.search_tools;
    expect(searchTools('parallel-web')).toEqual(['web_search', 'web_fetch']);
    // Tavily's crawl, map, research and feedback tools are left out: they walk sites or write back.
    expect(searchTools('tavily')).toEqual(['tavily_search', 'tavily_extract']);
    expect(searchTools('exa')).toEqual(['web_search_exa', 'web_fetch_exa', 'web_search_advanced_exa']);
    expect(searchTools('github')).toBeUndefined();
    expect(searchTools('stripe')).toBeUndefined();
  });

  it('looks up the search tools by endpoint, ignoring a key in the query string or a trailing slash', () => {
    const catalog = McpCatalog.loadShipped();
    expect(catalog.searchToolsForUrl('https://mcp.tavily.com/mcp')).toEqual(['tavily_search', 'tavily_extract']);
    expect(catalog.searchToolsForUrl('https://mcp.tavily.com/mcp/?tavilyApiKey=synthetic')).toEqual([
      'tavily_search',
      'tavily_extract',
    ]);
    expect(catalog.searchToolsForUrl('https://MCP.TAVILY.COM/mcp#frag')).toEqual(['tavily_search', 'tavily_extract']);
  });

  it('gives no search tools to another host, another path, another scheme, or something that is not a URL', () => {
    const catalog = McpCatalog.loadShipped();
    for (const url of [
      'https://mcp.tavily.com.evil.test/mcp',
      'https://evil.test/https://mcp.tavily.com/mcp',
      'https://mcp.tavily.com/other',
      'http://mcp.tavily.com/mcp',
      'https://api.githubcopilot.com/mcp/',
      'not a url',
    ]) {
      expect(catalog.searchToolsForUrl(url)).toEqual([]);
    }
  });

  it('declares the session id and model name as Parallel’s plumbing arguments, and none for other presets', () => {
    const catalog = McpCatalog.loadShipped();
    expect(catalog.presetForUrl('https://search.parallel.ai/mcp')?.search_plumbing_fields).toEqual([
      'session_id',
      'model_name',
    ]);
    expect(catalog.presetForUrl('https://mcp.tavily.com/mcp')?.search_plumbing_fields).toBeUndefined();
  });

  it('keeps the plumbing arguments out of the public catalog list', () => {
    const parallel = McpCatalog.loadShipped()
      .list()
      .find(entry => entry.name === 'parallel-web');
    expect(parallel).toBeDefined();
    expect(Object.keys(parallel ?? {})).not.toContain('search_plumbing_fields');
  });

  it('grants the stored search tools as they are, with the preset’s plumbing arguments', () => {
    const grant = McpCatalog.loadShipped().searchProviderGrant({
      url: 'https://search.parallel.ai/mcp',
      storedTools: ['stored_tool'],
    });
    expect(grant).toEqual({ tools: ['stored_tool'], plumbing_fields: ['session_id', 'model_name'] });
  });

  it('falls back to the preset’s search tools for a designated connector saved without any', () => {
    const catalog = McpCatalog.loadShipped();
    for (const url of ['https://search.parallel.ai/mcp', 'https://search.parallel.ai/mcp/?key=invented']) {
      expect(catalog.searchProviderGrant({ url, storedTools: [] })).toEqual({
        tools: ['web_search', 'web_fetch'],
        plumbing_fields: ['session_id', 'model_name'],
      });
    }
  });

  it('grants nothing from the catalog to a designated connector that is no known preset', () => {
    expect(
      McpCatalog.loadShipped().searchProviderGrant({ url: 'https://search.invented.example/mcp', storedTools: [] }),
    ).toEqual({
      tools: [],
      plumbing_fields: [],
    });
  });

  it('rejects a preset whose search tools are not a short list of names', () => {
    const accepts = (search_tools: unknown) =>
      McpCatalogFileSchema.safeParse({
        mcp_servers: [
          {
            type: 'remote',
            name: 'example-search',
            url: 'https://example.test/mcp',
            description: 'An example search server.',
            search_tools,
          },
        ],
      }).success;
    expect(accepts(['web_search'])).toBe(true);
    expect(accepts([''])).toBe(false);
    expect(accepts('web_search')).toBe(false);
    expect(accepts(Array.from({ length: 17 }, (_, i) => `tool_${String(i)}`))).toBe(false);
  });
});
