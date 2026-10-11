/**
 * Host-only search-provider field carried alongside the generic connector port.
 *
 * The upstream assistant UI runtime knows only generic MCP connectors. The server stores the
 * user's web search provider as one of those rows with this extension flag; the SDK owns the
 * field's shape, so the catalog adapter and the connector settings derive it from there.
 */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { ConnectorBase, ConnectorCatalogEntry } from './types.js';

export type SearchProviderFields = Pick<TrueForgeApi.RemoteMcpServerManifest, 'searchProvider'>;

/** Reads the flag off the row: the runtime's `ConnectorBase` does not declare it. */
export function isSearchProvider(connector: ConnectorBase): boolean {
  return 'searchProvider' in connector && connector.searchProvider === true;
}

/** Whether a catalog preset offers to become the search provider; `ConnectorCatalogEntry` does not declare it. */
export function offersSearchProvider(entry: ConnectorCatalogEntry): boolean {
  return 'searchProvider' in entry && entry.searchProvider === true;
}
