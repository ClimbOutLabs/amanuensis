/**
 * Shipped MCP catalog (mcp-catalog.yaml): the discovery list of server
 * presets offered by GET /catalogs/mcp-servers for the UI to copy into
 * PUT /settings/mcp-servers bodies. Beyond discovery, a preset carries the search declaration
 * of the server it describes, which the connector record copies when the person designates
 * that server as the web search provider. Downstream of the designation, nothing reads the
 * catalog for a connector again: the record is the one place the declaration lives.
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
      const { search_plumbing_fields: serverOnly, search_in_process: serverOnlyInProcess, ...preset } = entry;
      void serverOnly;
      void serverOnlyInProcess;
      return preset;
    });
  }

  /** Names of the presets offered as a web search provider (today parallel-web and tavily). */
  searchProviderPresetNames(): readonly string[] {
    return this.mcpServers.filter(entry => entry.search_provider === true).map(entry => entry.name);
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

  /**
   * The search declaration the preset at this endpoint carries, undefined for any other server
   * and for a preset that carries no search declaration.
   * Read at designation time and by the boot-time defaults, which copy it onto the connector
   * record; nothing reads it for a connector that is already designated.
   */
  searchDeclarationForUrl(url: string): SearchDeclaration | undefined {
    const preset = this.presetForUrl(url);
    if (preset === undefined || (preset.search_tools === undefined && preset.page_read_tools === undefined)) {
      return undefined;
    }
    return {
      search_tools: preset.search_tools ?? [],
      page_read_tools: preset.page_read_tools ?? [],
      plumbing_fields: preset.search_plumbing_fields ?? [],
      in_process: preset.search_in_process === true,
    };
  }

  /**
   * What a designated search provider may do silently, built from the declaration stored on
   * its connector record. A record written before the declaration was split into search and
   * page-read tools holds one mixed list: the split is recomputed for it here from its
   * preset's declaration, the one read that still consults the catalog, and it runs until
   * the record is saved again and stores the split itself. A legacy record at no preset's
   * endpoint keeps its whole list as search tools and gains no page readers, the closest
   * honest reading of what was stored.
   */
  searchProviderGrant({ manifest }: { manifest: StoredSearchDeclaration }): SearchProviderGrant {
    if (manifest.page_read_tools !== undefined) {
      return {
        tools: manifest.search_tools ?? [],
        page_read_tools: manifest.page_read_tools,
        plumbing_fields: manifest.search_plumbing_fields ?? [],
        served_in_process: manifest.search_in_process === true,
      };
    }
    const stored = manifest.search_tools ?? [];
    const preset = this.presetForUrl(manifest.url);
    if (preset === undefined) {
      return { tools: stored, page_read_tools: [], plumbing_fields: [], served_in_process: false };
    }
    if (stored.length === 0) {
      return {
        tools: preset.search_tools ?? [],
        page_read_tools: preset.page_read_tools ?? [],
        plumbing_fields: preset.search_plumbing_fields ?? [],
        served_in_process: preset.search_in_process === true,
      };
    }
    const presetPageReaders = new Set(preset.page_read_tools ?? []);
    return {
      tools: stored.filter(name => !presetPageReaders.has(name)),
      page_read_tools: stored.filter(name => presetPageReaders.has(name)),
      plumbing_fields: preset.search_plumbing_fields ?? [],
      served_in_process: preset.search_in_process === true,
    };
  }
}

/** The search declaration as one source states it: a preset, or a capture from a server's own tool list. */
export interface SearchDeclaration {
  search_tools: readonly string[];
  page_read_tools: readonly string[];
  plumbing_fields: readonly string[];
  in_process: boolean;
}

/** The search fields of a stored connector record, as the grant builder reads them. */
export interface StoredSearchDeclaration {
  url: string;
  search_tools?: readonly string[] | undefined;
  page_read_tools?: readonly string[] | undefined;
  search_plumbing_fields?: readonly string[] | undefined;
  search_in_process?: boolean | undefined;
}

function endpointKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}
