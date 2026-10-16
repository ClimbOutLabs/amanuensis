import winston from 'winston';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { DEFAULT_SENTINEL_USER_SETTINGS } from '../../../src/db/sentinelSettingsStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import {
  DEFAULT_SEARCH_PROVIDER_SEEDED_KEY,
  seedDefaultSearchProvider,
} from '../../../src/runtime/defaultSearchProvider';
import { getMcpConnection } from '../../../src/runtime/sessionResources';

const logger = winston.createLogger({ silent: true });
const TENANT = 'default';
const PARALLEL_URL = 'https://search.parallel.ai/mcp';

async function createFixture() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const mcpServerStore: IMcpServerWithAuthStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore: new SqliteOAuthTokenStore(db),
    clientName: 'test-client',
  });
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const catalog = McpCatalog.load();
  return {
    mcpServerStore,
    globalSettingsStore,
    catalog,
    seed: (overrides?: { catalog?: McpCatalog }) =>
      seedDefaultSearchProvider({
        globalSettingsStore,
        mcpServerStore,
        catalog: overrides?.catalog ?? catalog,
        tenant_id: TENANT,
        logger,
      }),
    names: async () => (await mcpServerStore.listServers({ tenant_id: TENANT, names: undefined })).map(s => s.name),
    save: (manifest: { name: string; url: string; search_provider?: boolean }) =>
      mcpServerStore.upsertServer({
        tenant_id: TENANT,
        name: manifest.name,
        manifest: { type: 'remote', description: 'Invented connector.', ...manifest },
        first_party: false,
      }),
  };
}

describe('seedDefaultSearchProvider', () => {
  it('adds the keyless Parallel connector as the search provider on a new instance', async () => {
    const f = await createFixture();

    await expect(f.seed()).resolves.toBe('added');

    const stored = await f.mcpServerStore.getServer({ tenant_id: TENANT, name: 'parallel-web' });
    expect(stored?.manifest).toMatchObject({
      type: 'remote',
      url: PARALLEL_URL,
      search_provider: true,
      search_tools: ['web_search', 'web_fetch'],
    });
    expect(stored?.manifest.auth).toBeUndefined();
    expect(stored?.first_party).toBe(false);
    await expect(f.globalSettingsStore.getSetting({ key: DEFAULT_SEARCH_PROVIDER_SEEDED_KEY })).resolves.toBeDefined();
  });

  it('is read by a turn as the search provider with the preset plumbing, and searches run without asking by default', async () => {
    const f = await createFixture();
    await f.seed();

    const connection = await getMcpConnection({
      tenant_id: TENANT,
      name: 'parallel-web',
      store: f.mcpServerStore,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
    });
    if (connection?.search_provider === undefined) {
      throw new Error('expected the seeded connector to be the search provider');
    }
    expect(f.catalog.searchProviderGrant({ url: connection.url, storedTools: connection.search_provider.tools })).toEqual(
      { tools: ['web_search', 'web_fetch'], plumbing_fields: ['session_id', 'model_name'] },
    );
    expect(DEFAULT_SENTINEL_USER_SETTINGS.search_without_asking).toBe(true);
  });

  it('adds it once: a connector the user removes stays removed across restarts', async () => {
    const f = await createFixture();
    await f.seed();
    await f.mcpServerStore.deleteServer({ tenant_id: TENANT, name: 'parallel-web' });

    await expect(f.seed()).resolves.toBe('already_offered');
    await expect(f.seed()).resolves.toBe('already_offered');

    expect(await f.names()).toEqual([]);
  });

  it('gives an existing instance with other connectors but no search provider the connector, once', async () => {
    const f = await createFixture();
    await f.save({ name: 'notes-mcp', url: 'https://notes.example/mcp' });

    await expect(f.seed()).resolves.toBe('added');
    expect((await f.names()).sort()).toEqual(['notes-mcp', 'parallel-web']);

    await f.mcpServerStore.deleteServer({ tenant_id: TENANT, name: 'parallel-web' });
    await expect(f.seed()).resolves.toBe('already_offered');
    expect(await f.names()).toEqual(['notes-mcp']);
  });

  it('leaves an instance alone that already chose a provider, and never offers it later', async () => {
    const f = await createFixture();
    await f.save({ name: 'finder-mcp', url: 'https://finder.example/mcp', search_provider: true });

    await expect(f.seed()).resolves.toBe('kept_existing');
    expect(await f.names()).toEqual(['finder-mcp']);

    await f.mcpServerStore.deleteServer({ tenant_id: TENANT, name: 'finder-mcp' });
    await expect(f.seed()).resolves.toBe('already_offered');
    expect(await f.names()).toEqual([]);
  });

  it('treats a search provider the user turned off as a choice', async () => {
    const f = await createFixture();
    await f.save({ name: 'finder-mcp', url: 'https://finder.example/mcp', search_provider: false });

    await expect(f.seed()).resolves.toBe('kept_existing');
    expect(await f.names()).toEqual(['finder-mcp']);
  });

  it('does not add a second connector when one already sits on the preset address, whatever its name', async () => {
    const f = await createFixture();
    await f.save({ name: 'my-parallel', url: `${PARALLEL_URL}/` });

    await expect(f.seed()).resolves.toBe('kept_existing');
    expect(await f.names()).toEqual(['my-parallel']);
  });

  it('does not overwrite a connector that already has the preset name at another address', async () => {
    const f = await createFixture();
    await f.save({ name: 'parallel-web', url: 'https://elsewhere.example/mcp' });

    await expect(f.seed()).resolves.toBe('kept_existing');
    const stored = await f.mcpServerStore.getServer({ tenant_id: TENANT, name: 'parallel-web' });
    expect(stored?.manifest).toMatchObject({ url: 'https://elsewhere.example/mcp' });
    expect(stored?.manifest.type === 'remote' ? stored.manifest.search_provider : undefined).toBeUndefined();
  });

  it('adds nothing and keeps no marker when the catalog has no keyless preset, so a later catalog can still offer it', async () => {
    const f = await createFixture();
    const keyed = new McpCatalog(
      f.catalog.list().map(entry => (entry.name === 'parallel-web' ? { ...entry, auth: { type: 'dcr' as const } } : entry)),
    );

    await expect(f.seed({ catalog: keyed })).resolves.toBe('no_preset');
    await expect(f.seed({ catalog: new McpCatalog([]) })).resolves.toBe('no_preset');

    expect(await f.names()).toEqual([]);
    await expect(f.globalSettingsStore.getSetting({ key: DEFAULT_SEARCH_PROVIDER_SEEDED_KEY })).resolves.toBeUndefined();
    await expect(f.seed()).resolves.toBe('added');
  });
});
