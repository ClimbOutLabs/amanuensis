/**
 * One-time data migration: a connector saved before the web search provider setting existed has no
 * designation, so its searches asked every time. When a tenant has no connector carrying the setting
 * at all and one matches a catalog preset offered as the search provider, that connector becomes the
 * provider with the preset's search tools.
 *
 * "Never set" is the absence of `search_provider`; "turned off" is an explicit `false`. Any explicit
 * value on any of a tenant's connectors means the user has already made a choice, so the tenant is left alone.
 * Cannot undo: the designation is ordinary user-editable data afterwards.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { McpCatalog } from '../catalog/McpCatalog';
import type { CatalogPreset } from '../schemas/mcpCatalog';
import { asRecord } from './applyNameHyphenOnlyMigration';

export interface SearchProviderDefaultDialect {
  /** How to read the manifest JSON column (SQLite needs json(column)). */
  readManifest(): RawBuilder<unknown>;
  /** The manifest with these top-level keys set and every other key kept. */
  mergeIntoManifest(patch: Record<string, unknown>): RawBuilder<unknown>;
  touchUpdatedAt(): RawBuilder<unknown>;
}

interface StoredConnector {
  id: string;
  tenant_id: string;
  name: string;
  manifest: Record<string, unknown>;
}

/** The catalog preset a stored connector's endpoint links to, when that preset is offered as the search provider. */
function searchProviderPreset({
  connector,
  catalog,
}: {
  connector: StoredConnector;
  catalog: McpCatalog;
}): CatalogPreset | undefined {
  const url = connector.manifest['url'];
  if (connector.manifest['type'] !== 'remote' || typeof url !== 'string') {
    return undefined;
  }
  const preset = catalog.presetForUrl(url);
  return preset?.search_provider === true ? preset : undefined;
}

/** The connector to designate for one tenant, or undefined when the tenant made a choice or has no match. */
function connectorToDesignate({
  connectors,
  catalog,
}: {
  connectors: readonly StoredConnector[];
  catalog: McpCatalog;
}): { id: string; preset: CatalogPreset } | undefined {
  if (connectors.some(connector => connector.manifest['search_provider'] !== undefined)) {
    return undefined;
  }
  const catalogOrder = catalog.list();
  const matches = connectors.flatMap(connector => {
    const preset = searchProviderPreset({ connector, catalog });
    return preset === undefined ? [] : [{ id: connector.id, name: connector.name, preset }];
  });
  // The catalog's own order is the product's preference; the name keeps ties deterministic.
  matches.sort(
    (a, b) => catalogOrder.indexOf(a.preset) - catalogOrder.indexOf(b.preset) || a.name.localeCompare(b.name),
  );
  return matches[0];
}

/** Returns how many connectors were designated. */
export async function applySearchProviderDefaultMigration<TDatabase>({
  db,
  dialect,
  catalog,
}: {
  db: Kysely<TDatabase>;
  dialect: SearchProviderDefaultDialect;
  catalog: McpCatalog;
}): Promise<number> {
  const rows = await sql<{ id: string; tenant_id: string; name: string; manifest: unknown }>`
    SELECT id, tenant_id, name, ${dialect.readManifest()} AS manifest FROM mcp_server
    ORDER BY tenant_id, name
  `.execute(db);

  const byTenant = new Map<string, StoredConnector[]>();
  for (const row of rows.rows) {
    const manifest = asRecord(row.manifest);
    if (manifest !== undefined) {
      byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), { ...row, manifest }]);
    }
  }

  // One UPDATE per preset, not per tenant: the catalog is small, the tenant count is not.
  const idsByPreset = new Map<string, string[]>();
  for (const connectors of byTenant.values()) {
    const chosen = connectorToDesignate({ connectors, catalog });
    if (chosen !== undefined) {
      idsByPreset.set(chosen.preset.name, [...(idsByPreset.get(chosen.preset.name) ?? []), chosen.id]);
    }
  }

  let designated = 0;
  for (const [presetName, ids] of idsByPreset) {
    const tools = catalog.list().find(entry => entry.name === presetName)?.search_tools ?? [];
    const patch = { search_provider: true, ...(tools.length > 0 ? { search_tools: tools } : {}) };
    await sql`
      UPDATE mcp_server
      SET manifest = ${dialect.mergeIntoManifest(patch)}, updated_at = ${dialect.touchUpdatedAt()}
      WHERE id IN (${sql.join(ids)})
    `.execute(db);
    designated += ids.length;
  }
  console.log(`search-provider-default migration: tenants=${String(byTenant.size)} designated=${String(designated)}`);
  return designated;
}
