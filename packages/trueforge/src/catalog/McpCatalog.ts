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
import { McpCatalogFileSchema, type CatalogMcpServer, type CatalogPreset } from '../schemas/mcpCatalog';
import { loadYamlAtPath, parseYamlString } from './loadYaml';
import { shippedMcpCatalogYaml } from './mcpCatalog.gen';

export class McpCatalog {
  private readonly mcpServers: readonly CatalogPreset[];

  constructor(mcpServers: readonly CatalogPreset[]) {
    this.mcpServers = mcpServers;
  }

  /**
   * Loads and validates the catalog, from `catalogPath` when set. Throws on any error. The caller
   * passes the path so this module stays free of runtime config: migrations bundle it on its own.
   */
  static load(catalogPath: string | undefined): McpCatalog {
    if (catalogPath !== undefined) {
      const file = loadYamlAtPath(catalogPath, McpCatalogFileSchema);
      return new McpCatalog(file.mcp_servers);
    }
    return McpCatalog.loadShipped();
  }

  /** The catalog this build ships, ignoring `MCP_CATALOG_PATH`, so a migration gives the same result on every database. */
  static loadShipped(): McpCatalog {
    const file = parseYamlString(shippedMcpCatalogYaml, McpCatalogFileSchema, 'shipped mcp-catalog');
    return new McpCatalog(file.mcp_servers);
  }

  /** The presets as the public catalog shows them, without what only the server reads. */
  list(): readonly CatalogMcpServer[] {
    return this.mcpServers.map(entry => {
      const { search_plumbing_fields: serverOnly, ...preset } = entry;
      void serverOnly;
      return preset;
    });
  }

  /**
   * The preset at this endpoint, undefined for any other server. Matched on origin and path so a
   * key carried in the query string does not hide a known provider.
   */
  presetForUrl(url: string): CatalogPreset | undefined {
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
