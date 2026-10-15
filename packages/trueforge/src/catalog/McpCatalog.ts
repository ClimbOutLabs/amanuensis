/**
 * Shipped MCP catalog (mcp-catalog.yaml): the discovery list of server
 * presets offered by GET /catalogs/mcp-servers for the UI to copy into
 * PUT /settings/mcp-servers bodies. Beyond discovery, a saved connector is linked to its preset
 * by endpoint to learn a known web search provider's search tools and plumbing arguments.
 *
 * Default: YAML inlined into `mcpCatalog.gen.ts` at build time. Optional
 * override: `MCP_CATALOG_PATH` (file on disk).
 */
import type { SearchProviderGrant } from '@truefoundry/trueforge-core/core';
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
   * The preset at this endpoint, undefined for any other server. Matched on origin and path so a
   * key carried in the query string does not hide a known provider.
   */
  presetForUrl(url: string): CatalogMcpServer | undefined {
    const key = endpointKey(url);
    if (key === undefined) {
      return undefined;
    }
    return this.mcpServers.find(entry => endpointKey(entry.url) === key);
  }

  /** Search tools the catalog lists for the preset at this endpoint, empty for any other server. */
  searchToolsForUrl(url: string): readonly string[] {
    return this.presetForUrl(url)?.search_tools ?? [];
  }

  /**
   * What a designated search provider may do silently. Stored tools win when present; a connector
   * saved before the tools were recorded falls back to its preset's list. Plumbing arguments are
   * always the catalog's say, since they are never stored.
   */
  searchProviderGrant({ url, storedTools }: { url: string; storedTools: readonly string[] }): SearchProviderGrant {
    const preset = this.presetForUrl(url);
    return {
      tools: storedTools.length > 0 ? storedTools : (preset?.search_tools ?? []),
      plumbing_fields: preset?.search_plumbing_fields ?? [],
    };
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
