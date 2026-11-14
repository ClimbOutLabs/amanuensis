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
    expect(catalog.searchProviderGrant({ manifest: { url: 'https://mcp.tavily.com/mcp', search_tools: [] } })).toEqual({
      tools: ['tavily_search'],
      page_read_tools: ['tavily_extract'],
      plumbing_fields: [],
      served_in_process: true,
    });
  });

  it('lists the real search and page-read tools of Parallel, Tavily and Exa, and none for a server that cannot search', () => {
    const catalog = McpCatalog.loadShipped();
    const searchTools = (name: string) => catalog.list().find(server => server.name === name)?.search_tools;
    const pageReadTools = (name: string) => catalog.list().find(server => server.name === name)?.page_read_tools;
    expect(searchTools('parallel-web')).toEqual(['web_search']);
    expect(pageReadTools('parallel-web')).toEqual(['web_fetch']);
    // Tavily's crawl, map, research and feedback tools are left out: they walk sites or write back.
    expect(searchTools('tavily')).toEqual(['tavily_search']);
    expect(pageReadTools('tavily')).toEqual(['tavily_extract']);
    expect(searchTools('exa')).toEqual(['web_search_exa', 'web_search_advanced_exa']);
    expect(pageReadTools('exa')).toEqual(['web_fetch_exa']);
    expect(searchTools('github')).toBeUndefined();
    expect(searchTools('stripe')).toBeUndefined();
  });

  it('reads the search declaration by endpoint, ignoring a key in the query string or a trailing slash', () => {
    const catalog = McpCatalog.loadShipped();
    const tavilyDeclaration = {
      search_tools: ['tavily_search'],
      page_read_tools: ['tavily_extract'],
      plumbing_fields: [],
      in_process: true,
    };
    expect(catalog.searchDeclarationForUrl('https://mcp.tavily.com/mcp')).toEqual(tavilyDeclaration);
    expect(catalog.searchDeclarationForUrl('https://mcp.tavily.com/mcp/?tavilyApiKey=synthetic')).toEqual(
      tavilyDeclaration,
    );
    expect(catalog.searchDeclarationForUrl('https://MCP.TAVILY.COM/mcp#frag')).toEqual(tavilyDeclaration);
  });

  it('gives no search declaration to another host, another path, another scheme, or something that is not a URL', () => {
    const catalog = McpCatalog.loadShipped();
    for (const url of [
      'https://mcp.tavily.com.evil.test/mcp',
      'https://evil.test/https://mcp.tavily.com/mcp',
      'https://mcp.tavily.com/other',
      'http://mcp.tavily.com/mcp',
      'https://api.githubcopilot.com/mcp/',
      'not a url',
    ]) {
      expect(catalog.searchDeclarationForUrl(url)).toBeUndefined();
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

  it('keeps the plumbing arguments and the in-process mark out of the public catalog list', () => {
    const parallel = McpCatalog.loadShipped()
      .list()
      .find(entry => entry.name === 'parallel-web');
    expect(parallel).toBeDefined();
    expect(Object.keys(parallel ?? {})).not.toContain('search_plumbing_fields');
    expect(Object.keys(parallel ?? {})).not.toContain('search_in_process');
  });

  it('grants the stored declaration as it is, with the record’s plumbing fields', () => {
    const grant = McpCatalog.loadShipped().searchProviderGrant({
      manifest: {
        url: 'https://search.parallel.ai/mcp',
        search_tools: ['stored_tool'],
        page_read_tools: ['stored_fetch'],
        search_plumbing_fields: ['session_id', 'model_name'],
      },
    });
    expect(grant).toEqual({
      tools: ['stored_tool'],
      page_read_tools: ['stored_fetch'],
      plumbing_fields: ['session_id', 'model_name'],
      served_in_process: false,
    });
  });

  it('falls back to the preset’s declaration for a designated connector saved without any list', () => {
    const catalog = McpCatalog.loadShipped();
    for (const url of ['https://search.parallel.ai/mcp', 'https://search.parallel.ai/mcp/?key=invented']) {
      expect(catalog.searchProviderGrant({ manifest: { url, search_tools: [] } })).toEqual({
        tools: ['web_search'],
        page_read_tools: ['web_fetch'],
        plumbing_fields: ['session_id', 'model_name'],
        served_in_process: false,
      });
    }
  });

  it('splits the one mixed list of a record written before the split, by its preset’s declaration', () => {
    const grant = McpCatalog.loadShipped().searchProviderGrant({
      manifest: { url: 'https://search.parallel.ai/mcp', search_tools: ['web_search', 'web_fetch'] },
    });
    expect(grant).toEqual({
      tools: ['web_search'],
      page_read_tools: ['web_fetch'],
      plumbing_fields: ['session_id', 'model_name'],
      served_in_process: false,
    });
  });

  it('keeps the whole stored list of an older record at an address no preset knows, as search tools', () => {
    const grant = McpCatalog.loadShipped().searchProviderGrant({
      manifest: { url: 'https://search.invented.example/mcp', search_tools: ['moon_search', 'moon_fetch'] },
    });
    expect(grant).toEqual({
      tools: ['moon_search', 'moon_fetch'],
      page_read_tools: [],
      plumbing_fields: [],
      served_in_process: false,
    });
  });

  it('grants nothing from the catalog to a designated connector that is no known preset', () => {
    expect(
      McpCatalog.loadShipped().searchProviderGrant({
        manifest: { url: 'https://search.invented.example/mcp', search_tools: [] },
      }),
    ).toEqual({
      tools: [],
      page_read_tools: [],
      plumbing_fields: [],
      served_in_process: false,
    });
  });

  it('ships the Notion preset at the address and sign-in shape Notion documents', () => {
    const notion = McpCatalog.loadShipped()
      .list()
      .find(server => server.name === 'notion');
    if (notion === undefined) {
      throw new Error('expected a notion preset in the shipped MCP catalog');
    }
    // Notion's own client guide names this endpoint (Streamable HTTP) and dynamic client
    // registration, which is the sign-in the catalog's dcr shape runs.
    expect(notion.url).toBe('https://mcp.notion.com/mcp');
    expect(notion.auth?.type).toBe('dcr');
    // The help line the preset carries: signing in gives the connection the same access
    // the person has, so it can reach any page or database they can open.
    expect(notion.description).toMatch(/same access you have/);
    expect(notion.description).not.toMatch(/cannot see anything you do not share/);
  });

  it('ships the GitHub preset at the address and token shape GitHub documents', () => {
    const github = McpCatalog.loadShipped()
      .list()
      .find(server => server.name === 'github');
    if (github === undefined) {
      throw new Error('expected a github preset in the shipped MCP catalog');
    }
    // GitHub's setup guide names this endpoint and a personal access token sent as a bearer
    // header; its OAuth is registered per client application, so a shipped preset cannot
    // carry it and the token is the shape a preset can fill.
    expect(github.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(github.auth?.type).toBe('header');
    expect(github.description).toMatch(/personal access token/);
  });

  it('ships no Slack preset, because its server cannot register this app by itself', () => {
    // Slack's MCP server has no dynamic client registration: it signs a person in only
    // through a Slack app that person registered first, whose client id and secret a
    // shipped catalog row cannot hold. A preset would fail at sign-in, so there is none;
    // a person adds Slack by hand with their own app's credentials instead.
    expect(
      McpCatalog.loadShipped()
        .list()
        .find(server => server.name === 'slack'),
    ).toBeUndefined();
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
