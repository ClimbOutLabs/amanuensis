import { isDeepStrictEqual } from 'node:util';

import type { McpServerRecord } from '../db/mcpServerStore';
import type { IOAuthClientStore } from '../mcp/auth/types';
import type { ResourceName } from '../schemas/common';
import type { RemoteMcpServerManifest } from '../schemas/mcpServer';
import type { McpCatalog } from './McpCatalog';

export interface DefaultSearchConnector {
  name: ResourceName;
  manifest: RemoteMcpServerManifest;
}

/**
 * The connector a new instance is given as its web search provider: the catalog's keyless search
 * preset, saved as is. A preset that needs a key cannot be given without the owner, so none is.
 */
export function defaultSearchConnector(catalog: McpCatalog): DefaultSearchConnector | undefined {
  const preset = catalog.list().find(entry => entry.search_provider === true && entry.auth === undefined);
  if (preset === undefined) {
    return undefined;
  }
  return {
    name: preset.name,
    manifest: {
      type: 'remote',
      name: preset.name,
      url: preset.url,
      description: preset.description,
      search_provider: true,
      search_tools: [...catalog.searchToolsForUrl(preset.url)],
    },
  };
}

/**
 * Whether a stored connector is the default search connector exactly as it was given: same name and
 * manifest, no trust mark and no sign-in client. Any edit, header or key makes it the owner's own.
 */
export async function isUntouchedDefaultSearchConnector<TTransaction>({
  record,
  catalog,
  clientStore,
}: {
  record: McpServerRecord;
  catalog: McpCatalog;
  clientStore: Pick<IOAuthClientStore<TTransaction>, 'getClient'>;
}): Promise<boolean> {
  const seeded = defaultSearchConnector(catalog);
  return (
    record.name === seeded?.name &&
    !record.first_party &&
    isDeepStrictEqual(record.manifest, seeded.manifest) &&
    (await clientStore.getClient({ id: record.id })) === undefined
  );
}
