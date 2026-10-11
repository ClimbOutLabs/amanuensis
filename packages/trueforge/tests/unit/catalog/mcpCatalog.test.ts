import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { parseMemoryProviderUrl } from '../../../src/runtime/memory/memoryProvider';

describe('shipped MCP catalog', () => {
  it('loads and validates every shipped preset', () => {
    expect(McpCatalog.load().list().length).toBeGreaterThan(0);
  });

  it('ships a hindsight preset whose placeholder URL is a shape memory can actually use', () => {
    const hindsight = McpCatalog.load()
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

  it('offers Parallel’s keyless hosted MCP as the one preset that becomes the web search provider', () => {
    const presets = McpCatalog.load().list();
    expect(presets.filter(server => server.search_provider === true).map(server => server.name)).toEqual([
      'parallel-web',
    ]);
    const parallel = presets.find(server => server.name === 'parallel-web');
    if (parallel === undefined) {
      throw new Error('expected a parallel-web preset in the shipped MCP catalog');
    }
    expect(parallel.url).toBe('https://search.parallel.ai/mcp');
    // Keyless: no credentials to ask for.
    expect(parallel.auth).toBeUndefined();
  });

  it('keeps Tavily as a preset a user can pick as the search provider, without making it the default', () => {
    const tavily = McpCatalog.load()
      .list()
      .find(server => server.name === 'tavily');
    expect(tavily?.url).toBe('https://mcp.tavily.com/mcp');
    expect(tavily?.search_provider).toBeUndefined();
  });
});
