/**
 * Shipped MCP catalog (mcp-catalog.yaml): the discovery list of server
 * presets offered by GET /catalogs/mcp-servers for the UI to copy into
 * PUT /settings/mcp-servers bodies. The only write-time lookup is the search
 * tools of a known web search provider; the runtime never reads it.
 *
 * Default: YAML inlined into `mcpCatalog.gen.ts` at build time. Optional
 * override: `MCP_CATALOG_PATH` (file on disk).
 */
import configuration from '../config';
import { McpCatalogFileSchema, type CatalogMcpServer } from '../schemas/mcpCatalog';
import { loadYamlAtPath, parseYamlString } from './loadYaml';
import { shippedMcpCatalogYaml } from './mcpCatalog.gen';

export class McpCatalog {
  private readonly mcpServers: readonly CatalogMcpServer[];

  constructor(mcpServers: readonly CatalogMcpServer[]) {
    this.mcpServers = mcpServers;
  }

  /** Loads and validates the catalog. Throws on any error. */
  static load(): McpCatalog {
    if (configuration.MCP_CATALOG_PATH !== undefined) {
      const file = loadYamlAtPath(configuration.MCP_CATALOG_PATH, McpCatalogFileSchema);
      return new McpCatalog(file.mcp_servers);
    }
    const file = parseYamlString(shippedMcpCatalogYaml, McpCatalogFileSchema, 'shipped mcp-catalog');
    return new McpCatalog(file.mcp_servers);
  }

  list(): readonly CatalogMcpServer[] {
    return this.mcpServers;
  }

  /**
   * Search tools the catalog lists for the preset at this endpoint, empty for any other server.
   * Matched on origin and path so a key carried in the query string does not hide a known provider.
   */
  searchToolsForUrl(url: string): readonly string[] {
    const key = endpointKey(url);
    if (key === undefined) {
      return [];
    }
    return this.mcpServers.find(entry => endpointKey(entry.url) === key)?.search_tools ?? [];
  }
}

function endpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}
