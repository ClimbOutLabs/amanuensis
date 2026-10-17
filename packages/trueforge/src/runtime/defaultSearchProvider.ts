import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { McpCatalog } from '../catalog/McpCatalog';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';

/** Global-settings key whose presence means the default search provider was already offered once. */
export const DEFAULT_SEARCH_PROVIDER_SEEDED_KEY = 'default_search_provider_seeded';

type DefaultSearchProviderOutcome = 'already_offered' | 'added' | 'kept_existing' | 'no_preset';

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
  // The catalog flags the preset to offer as the provider; one that needs a key cannot be seeded.
  const preset = catalog.list().find(entry => entry.search_provider === true && entry.auth === undefined);
  if (preset === undefined) {
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

/** Boot step: seeds once, never in TrueFoundry mode, and never lets a failure keep the server from starting. */
export async function seedDefaultSearchProviderAtBoot({
  trueFoundryMode,
  logger,
  ...seed
}: {
  trueFoundryMode: boolean;
  logger: Logger;
  globalSettingsStore: IGlobalSettingsStore;
  mcpServerStore: IMcpServerStore;
  catalog: McpCatalog;
  tenant_id: string;
}): Promise<void> {
  if (trueFoundryMode) {
    return;
  }
  try {
    await seedDefaultSearchProvider({ ...seed, logger });
  } catch (error) {
    logger.warn('Default web search connector could not be added', extractErrorLogFields(error));
  }
}
