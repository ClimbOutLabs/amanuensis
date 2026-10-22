import winston from 'winston';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import {
  designateTavilyAtBoot,
  seedDefaultSearchProvider,
  TAVILY_CONNECTOR_NAME,
} from '../../../src/runtime/defaultSearchProvider';

const TENANT = 'default';
const KEY = 'tvly-boot-test-key-0123456789';

async function createFixture() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const mcpServerStore: IMcpServerWithAuthStore = new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore: new SqliteOAuthTokenStore(db),
    clientName: 'test-client',
  });
  const globalSettingsStore = new SqliteGlobalSettingsStore(db);
  const catalog = McpCatalog.loadShipped();
  const logger = winston.createLogger({ silent: true });
  const designate = (overrides: { choice: 'parallel' | 'tavily'; tavilyApiKey: string | undefined }) =>
    designateTavilyAtBoot({ ...overrides, catalog, mcpServerStore, tenant_id: TENANT, logger });
  const holders = async () =>
    (await mcpServerStore.listServers({ tenant_id: TENANT, names: undefined }))
      .filter(server => server.manifest.type === 'remote' && server.manifest.search_provider === true)
      .map(server => server.name);
  return {
    mcpServerStore,
    globalSettingsStore,
    catalog,
    logger,
    designate,
    holders,
    seedDefault: () =>
      seedDefaultSearchProvider({ globalSettingsStore, mcpServerStore, catalog, tenant_id: TENANT, logger }),
    tavilyRecord: async () =>
      (await mcpServerStore.listServers({ tenant_id: TENANT, names: undefined })).find(
        server => server.name === TAVILY_CONNECTOR_NAME,
      ),
  };
}

describe('designateTavilyAtBoot', () => {
  it('does nothing when the instance is set to Parallel', async () => {
    const f = await createFixture();
    await f.designate({ choice: 'parallel', tavilyApiKey: KEY });
    expect(await f.tavilyRecord()).toBeUndefined();
  });

  it('refuses to start without a key, and says where to put it', async () => {
    const f = await createFixture();
    await expect(f.designate({ choice: 'tavily', tavilyApiKey: undefined })).rejects.toThrow(
      'Put your Tavily key in TAVILY_API_KEY',
    );
    expect(await f.tavilyRecord()).toBeUndefined();
  });

  it('writes the Tavily connector with its key and makes it the one search provider', async () => {
    const f = await createFixture();
    await f.designate({ choice: 'tavily', tavilyApiKey: KEY });
    const record = await f.tavilyRecord();
    expect(record?.manifest).toEqual({
      type: 'remote',
      name: 'tavily',
      url: 'https://mcp.tavily.com/mcp',
      description: expect.any(String),
      search_provider: true,
      search_tools: ['tavily_search', 'tavily_extract'],
      auth: { type: 'header', headers: { Authorization: `Bearer ${KEY}` } },
    });
    expect(await f.holders()).toEqual(['tavily']);
  });

  it('releases the role from a connector that held it, such as the seeded Parallel one', async () => {
    const f = await createFixture();
    await f.seedDefault();
    expect(await f.holders()).toEqual(['parallel-web']);
    await f.designate({ choice: 'tavily', tavilyApiKey: KEY });
    expect(await f.holders()).toEqual(['tavily']);
  });

  it('keeps Tavily as the provider after the default seed runs, so Parallel is not added', async () => {
    const f = await createFixture();
    await f.designate({ choice: 'tavily', tavilyApiKey: KEY });
    expect(await f.seedDefault()).toBe('kept_existing');
    expect(await f.holders()).toEqual(['tavily']);
  });

  it('takes a rotated key on the next start, and never logs it', async () => {
    const f = await createFixture();
    const infoSpy = jest.spyOn(f.logger, 'info');
    await f.designate({ choice: 'tavily', tavilyApiKey: KEY });
    await f.designate({ choice: 'tavily', tavilyApiKey: 'tvly-rotated-key-9876543210' });
    const record = await f.tavilyRecord();
    expect(record?.manifest.type === 'remote' && record.manifest.auth).toEqual({
      type: 'header',
      headers: { Authorization: 'Bearer tvly-rotated-key-9876543210' },
    });
    expect(await f.holders()).toEqual(['tavily']);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('tvly-');
  });
});
