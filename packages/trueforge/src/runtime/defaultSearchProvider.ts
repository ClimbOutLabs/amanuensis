import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import { defaultSearchConnector } from '../catalog/defaultSearchConnector';
import type { McpCatalog } from '../catalog/McpCatalog';
import type { SearchProviderChoice } from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { RemoteMcpServerManifest } from '../schemas/mcpServer';

/** Catalog name of the Tavily preset, the connector `SEARCH_PROVIDER=tavily` designates. */
export const TAVILY_CONNECTOR_NAME = 'tavily';

/** Global-settings key whose presence means the default search provider was already offered once. */
export const DEFAULT_SEARCH_PROVIDER_SEEDED_KEY = 'default_search_provider_seeded';

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
  const connector = defaultSearchConnector(catalog);
  if (connector === undefined) {
    return 'no_preset';
  }
  const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
  const hasChosen = servers.some(
    server =>
      server.name === connector.name ||
      catalog.presetForUrl(server.manifest.url)?.name === connector.name ||
      (server.manifest.type === 'remote' && server.manifest.search_provider !== undefined),
  );
  if (!hasChosen) {
    await mcpServerStore.upsertServer({
      tenant_id,
      name: connector.name,
      manifest: connector.manifest,
      first_party: false,
    });
    logger.info('Added the keyless web search connector as the search provider', { connector: connector.name });
  }
  await globalSettingsStore.setSetting({ key: DEFAULT_SEARCH_PROVIDER_SEEDED_KEY, value: new Date().toISOString() });
  return hasChosen ? 'kept_existing' : 'added';
}

/**
 * Boot step for `SEARCH_PROVIDER=tavily`: writes the Tavily connector with the key from the
 * environment and makes it the one search provider, releasing any other connector's role. It runs
 * on every start, so a rotated key takes effect; the key is never logged. Throws when the key is
 * missing, so an instance never quietly searches with a provider its owner did not pick.
 */
export async function designateTavilyAtBoot({
  choice,
  tavilyApiKey,
  catalog,
  mcpServerStore,
  tenant_id,
  logger,
}: {
  choice: SearchProviderChoice;
  tavilyApiKey: string | undefined;
  catalog: McpCatalog;
  mcpServerStore: IMcpServerStore;
  tenant_id: string;
  logger: Logger;
}): Promise<void> {
  if (choice !== 'tavily') {
    return;
  }
  if (tavilyApiKey === undefined) {
    throw new Error(
      'SEARCH_PROVIDER is set to tavily, but TAVILY_API_KEY is empty. Put your Tavily key in TAVILY_API_KEY in the instance .env file, then restart.',
    );
  }
  const preset = catalog.list().find(entry => entry.name === TAVILY_CONNECTOR_NAME);
  if (preset === undefined) {
    throw new Error('The connector catalog has no Tavily entry, so Tavily cannot be the search provider.');
  }
  const manifest: RemoteMcpServerManifest = {
    type: 'remote',
    name: preset.name,
    url: preset.url,
    description: preset.description,
    search_provider: true,
    search_tools: [...catalog.searchToolsForUrl(preset.url)],
    auth: { type: 'header', headers: { Authorization: `Bearer ${tavilyApiKey}` } },
  };
  await mcpServerStore.upsertServer({ tenant_id, name: preset.name, manifest, first_party: false });
  const servers = await mcpServerStore.listServers({ tenant_id, names: undefined });
  for (const server of servers) {
    if (server.name !== preset.name && server.manifest.type === 'remote' && server.manifest.search_provider === true) {
      await mcpServerStore.upsertServer({
        tenant_id,
        name: server.name,
        manifest: { ...server.manifest, search_provider: false },
        first_party: server.first_party,
      });
    }
  }
  logger.info('Set Tavily as the web search provider from SEARCH_PROVIDER', { connector: preset.name });
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
