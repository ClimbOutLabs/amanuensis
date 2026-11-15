/**
 * The first-party marker is the server's own mark on a stored connector. These tests drive the
 * settings router and read the record back: the wire never carries it, and a request can never
 * set it, so a saved connector is never first-party, even on an origin the host counts as
 * first-party.
 */
import winston from 'winston';
import { createSettingsMcpServersRouter } from '../../../src/apis/mcpServers';
import { TENANT_ID } from '../../../src/apis/sessions';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { getMcpConnection } from '../../../src/runtime/sessionResources';

const LISTED_ORIGIN = 'https://first-party.example.com';

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function manifestOf(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'remote' as const,
    name,
    url: 'https://mcp.example.com/mcp',
    description: `Connector "${name}".`,
    ...extra,
  };
}

describe('first-party marker on stored connectors', () => {
  const originalOrigins = configuration.FIRST_PARTY_MCP_ORIGINS;
  let router: ReturnType<typeof createSettingsMcpServersRouter>;
  let store: IMcpServerWithAuthStore;

  beforeAll(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const tokenStore = new SqliteOAuthTokenStore(db);
    store = new McpServerWithAuthStore({
      store: new SqliteMcpServerStore(db),
      tokenStore,
      clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
    });
    router = createSettingsMcpServersRouter({
      mcpCatalog: McpCatalog.loadShipped(),
      resolveMcpServerStore: () => store,
      tokenStore,
      toolGrantStore: new SqliteMcpToolGrantStore(db),
      withTransaction: callback => db.transaction().execute(callback),
      logger: winston.createLogger({ silent: true }),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
  });

  beforeEach(() => {
    configuration.FIRST_PARTY_MCP_ORIGINS = [LISTED_ORIGIN];
  });

  afterAll(() => {
    configuration.FIRST_PARTY_MCP_ORIGINS = originalOrigins;
  });

  afterEach(async () => {
    for (const server of await store.listServers({ tenant_id: TENANT_ID, names: undefined })) {
      await store.deleteServer({ tenant_id: TENANT_ID, name: server.name });
    }
  });

  async function firstPartyOf(name: string): Promise<boolean | undefined> {
    return (await store.getServer({ tenant_id: TENANT_ID, name }))?.first_party;
  }

  /** What a turn would treat the connector as, which re-reads the operator's list. */
  async function firstPartyForTurn(name: string): Promise<boolean | undefined> {
    return (
      await getMcpConnection({
        tenant_id: TENANT_ID,
        name,
        store,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      })
    )?.first_party;
  }

  async function save(method: 'POST' | 'PUT', manifest: unknown): Promise<Response> {
    return await router.request('/', jsonInit(method, { manifest }));
  }

  describe('who can grant it', () => {
    it('never marks a connector added by URL, even one on a listed origin', async () => {
      const created = await save('POST', manifestOf('notes'));
      const replaced = await save('PUT', manifestOf('notes', { description: 'Edited.' }));
      const onListedOrigin = await save('POST', manifestOf('docs', { url: `${LISTED_ORIGIN}/mcp/docs` }));

      expect([created.status, replaced.status, onListedOrigin.status]).toEqual([201, 200, 201]);
      expect(await firstPartyOf('notes')).toBe(false);
      expect(await firstPartyOf('docs')).toBe(false);
    });

    it('never marks the search provider first-party, even on a listed origin: the role is a different trust', async () => {
      const created = await save(
        'POST',
        manifestOf('finder', { url: `${LISTED_ORIGIN}/mcp/finder`, search_provider: true }),
      );
      const replaced = await save(
        'PUT',
        manifestOf('finder', { url: `${LISTED_ORIGIN}/mcp/finder`, search_provider: true, description: 'Edited.' }),
      );

      expect([created.status, replaced.status]).toEqual([201, 200]);
      expect(await firstPartyOf('finder')).toBe(false);
      expect(await firstPartyForTurn('finder')).toBe(false);
    });

    it('does not carry the marker on the wire', async () => {
      const response = await save('POST', manifestOf('notes'));

      expect(JSON.stringify(await response.json())).not.toContain('first_party');
      const read = await router.request('/notes');
      expect(JSON.stringify(await read.json())).not.toContain('first_party');
    });

    it.each(['POST', 'PUT'] as const)(
      'rejects a %s whose manifest tries to set the marker, and stores nothing',
      async method => {
        const response = await save(method, manifestOf('notes', { first_party: true }));

        expect(response.status).toBe(400);
        expect(await firstPartyOf('notes')).toBeUndefined();
      },
    );

    it.each(['POST', 'PUT'] as const)('rejects a %s that sets the marker beside the manifest', async method => {
      const response = await router.request(
        '/',
        jsonInit(method, { manifest: manifestOf('notes'), first_party: true }),
      );

      expect(response.status).toBe(400);
      expect(await firstPartyOf('notes')).toBeUndefined();
    });

    it('leaves an existing connector untrusted when an update tries to set the marker', async () => {
      await save('PUT', manifestOf('notes'));

      const response = await save('PUT', manifestOf('notes', { first_party: true }));

      expect(response.status).toBe(400);
      expect(await firstPartyOf('notes')).toBe(false);
    });

    it('clears a stored marker when the connector is saved again', async () => {
      await store.upsertServer({
        tenant_id: TENANT_ID,
        name: 'notes',
        manifest: manifestOf('notes', { url: `${LISTED_ORIGIN}/mcp/notes` }),
        first_party: true,
      });

      const response = await save('PUT', manifestOf('notes', { url: `${LISTED_ORIGIN}/mcp/notes` }));

      expect(response.status).toBe(200);
      expect(await firstPartyOf('notes')).toBe(false);
      expect(await firstPartyForTurn('notes')).toBe(false);
    });
  });

  describe('the names Email and Calendar', () => {
    // Connector names must be lowercase, so these two reserved names can only reach the store from the host's own
    // setup and from an import, which checks them itself. This pins that the settings API stays closed to them.
    it.each(['POST', 'PUT'] as const)('%s turns the names away before anything is written', async method => {
      for (const name of ['Email', 'Calendar']) {
        const response = await save(method, manifestOf(name));

        expect(response.status).toBe(400);
        expect(await store.getServer({ tenant_id: TENANT_ID, name })).toBeUndefined();
      }
    });
  });
});
