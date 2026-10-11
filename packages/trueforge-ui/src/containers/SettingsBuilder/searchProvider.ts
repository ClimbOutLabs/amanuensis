/**
 * What the connector settings need to know about the web search provider role.
 *
 * The role is a flag on an ordinary connector row, like the memory provider. The server allows one
 * holder, so the flag moves in two steps: turn it off on the holder, then on for another connector.
 */
import type { MemoryProviderUpdateRequest } from '@/server/memoryProviderTypes.js';
import { isSearchProvider, offersSearchProvider, type SearchProviderFields } from '@/server/searchProviderTypes.js';
import type { ConnectorBase, ConnectorCatalogEntry } from '@/server/types.js';
import { isMemoryProvider, memoryProviderUpdateRequest } from './memoryProvider.js';

/** A full manifest with the search provider role set as asked, and every other field kept. */
export function searchProviderUpdateRequest(
  connector: ConnectorBase,
  searchProvider: boolean,
): MemoryProviderUpdateRequest & SearchProviderFields {
  return { ...memoryProviderUpdateRequest(connector, isMemoryProvider(connector)), searchProvider };
}

/** The role a connector added from a catalog preset starts with: the preset's own, when nobody holds it yet. */
export function searchProviderForNewConnector({
  entry,
  configured,
}: {
  entry: ConnectorCatalogEntry;
  configured: readonly ConnectorBase[];
}): SearchProviderFields {
  return offersSearchProvider(entry) && !configured.some(isSearchProvider) ? { searchProvider: true } : {};
}
