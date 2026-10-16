import type { Logger } from 'winston';

import type { McpCatalog } from '../catalog/McpCatalog';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';

/** Global-settings key whose presence means the default search provider was already offered once. */
export const DEFAULT_SEARCH_PROVIDER_SEEDED_KEY = 'default_search_provider_seeded';

/** Catalog preset offered as the default web search provider: free and needs no API key. */
export const DEFAULT_SEARCH_PROVIDER_PRESET = 'parallel-web';

export type DefaultSearchProviderOutcome = 'already_offered' | 'added' | 'kept_existing' | 'no_preset';

/**
 * Adds the keyless search preset as the web search provider, once per instance. The marker is
 * written whether or not anything was added, so a user who removes the connector keeps it removed
 * and a user who chose a provider is never given a second one. An instance with any connector
 * carrying an explicit search setting, on or off, or one already on the preset's address, counts as
 * having chosen. Unlike the data migration that designates a legacy connector, this also covers
 * instances with no connectors at all.
 */
export async function seedDefaultSearchProvider({
  globalSettingsStore,
  mcpServerStore,
  catalog,
  tenant_id,
  logger,
}: {
  globalSettingsStore: IGlobalSettingsStore;
  mcpServerStore: IMcpServerStore;
  catalog: McpCatalog;
  tenant_id: string;
  logger: Logger;
}): Promise<DefaultSearchProviderOutcome> {
  if ((await globalSettingsStore.getSetting({ key: DEFAULT_SEARCH_PROVIDER_SEEDED_KEY })) !== undefined) {
    return 'already_offered';
  }
  const preset = catalog.list().find(entry => entry.name === DEFAULT_SEARCH_PROVIDER_PRESET);
  if (preset === undefined || preset.auth !== undefined) {
    return 'no_preset';
  }
  const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
  const hasChosen = servers.some(
    server =>
      server.name === preset.name ||
      catalog.presetForUrl(server.manifest.url)?.name === preset.name ||
      (server.manifest.type === 'remote' && server.manifest.search_provider !== undefined),
  );
  if (!hasChosen) {
    await mcpServerStore.upsertServer({
      tenant_id,
      name: preset.name,
      manifest: {
        type: 'remote',
        name: preset.name,
        url: preset.url,
        description: preset.description,
        search_provider: true,
        search_tools: [...catalog.searchToolsForUrl(preset.url)],
      },
      first_party: false,
    });
    logger.info('Added the keyless web search connector as the search provider', { connector: preset.name });
  }
  await globalSettingsStore.setSetting({ key: DEFAULT_SEARCH_PROVIDER_SEEDED_KEY, value: new Date().toISOString() });
  return hasChosen ? 'kept_existing' : 'added';
}
