/**
 * The first-party marker is the server's own mark on a stored connector. These tests drive the
 * settings router and read the record back: the wire never carries it, a request can never set it,
 * and only the memory provider setup grants it, after its connection check passes and only on an
 * origin the operator listed in `FIRST_PARTY_MCP_ORIGINS`. The memory provider check is answered
 * with 200 for every host here, as a hostile server would answer it, so the list is the only gate.
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

const LISTED_ORIGIN = 'https://hindsight.example.com';
const MEMORY_URL = `${LISTED_ORIGIN}/mcp/aman/`;
const OTHER_BANK_URL = `${LISTED_ORIGIN}/mcp/other/`;
const ATTACKER_URL = 'https://attacker.example.net/mcp/aman';
/** The memory provider check dials this REST route behind every MCP URL, never the MCP surface. */
const RECALL_ROUTE = /\/v1\/default\/banks\/[^/]+\/memories\/recall$/;

function recallResponse(status: number): Response {
  const text = JSON.stringify(status === 200 ? { results: [], entities: {} } : { detail: 'Invalid API key' });
  return new Response(text, {
    status,
    headers: { 'content-length': String(Buffer.byteLength(text, 'utf8')), 'content-type': 'application/json' },
  });
}

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
  const originalFetch = globalThis.fetch;
  const originalOrigins = configuration.FIRST_PARTY_MCP_ORIGINS;
  let router: ReturnType<typeof createSettingsMcpServersRouter>;
  let store: IMcpServerWithAuthStore;
  let recallStatus = 200;

  beforeAll(async () => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (RECALL_ROUTE.test(url)) {
        return recallResponse(recallStatus);
      }
      return await originalFetch(input, init);
    };

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
    globalThis.fetch = originalFetch;
    configuration.FIRST_PARTY_MCP_ORIGINS = originalOrigins;
  });

  afterEach(async () => {
    recallStatus = 200;
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
    it('marks a connector first-party when it is created as the memory provider on a listed origin and its check passes', async () => {
      const response = await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));

      expect(response.status).toBe(201);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('marks a connector first-party when an update creates it as the memory provider', async () => {
      const response = await save('PUT', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));

      expect(response.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('marks a connector first-party when an update makes it the memory provider', async () => {
      await save('PUT', manifestOf('memory', { url: MEMORY_URL }));
      expect(await firstPartyOf('memory')).toBe(false);

      const response = await save('PUT', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));

      expect(response.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(true);
    });

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
      const response = await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));

      expect(JSON.stringify(await response.json())).not.toContain('first_party');
      const read = await router.request('/memory');
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

    it('does not mark a connector whose memory provider check fails, and writes nothing', async () => {
      recallStatus = 401;

      const created = await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(created.status).toBe(422);
      expect(await firstPartyOf('memory')).toBeUndefined();

      await save('PUT', manifestOf('memory', { url: MEMORY_URL }));
      const updated = await save('PUT', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(updated.status).toBe(422);
      expect(await firstPartyOf('memory')).toBe(false);
    });
  });

  describe('origins the operator did not list', () => {
    it.each(['POST', 'PUT'] as const)(
      'does not mark a memory provider on an unlisted origin by a %s, though its check passes',
      async method => {
        const response = await save(method, manifestOf('memory', { url: ATTACKER_URL, memory_provider: true }));

        expect(response.status).toBe(method === 'POST' ? 201 : 200);
        expect(await firstPartyOf('memory')).toBe(false);
        expect(await firstPartyForTurn('memory')).toBe(false);
      },
    );

    it.each([
      ['another port', 'https://hindsight.example.com:8443/mcp/aman'],
      ['http instead of https', 'http://hindsight.example.com/mcp/aman'],
      ['a host that ends with the listed host', 'https://evil-hindsight.example.com/mcp/aman'],
      ['a host that starts with the listed host', 'https://hindsight.example.com.attacker.example.net/mcp/aman'],
      ['the listed host written before an @', 'https://hindsight.example.com@attacker.example.net/mcp/aman'],
    ])('does not mark a lookalike of the listed origin: %s', async (_label, url) => {
      const response = await save('POST', manifestOf('memory', { url, memory_provider: true }));

      expect(response.status).toBe(201);
      expect(await firstPartyOf('memory')).toBe(false);
    });

    it('marks nothing while the operator has listed nothing', async () => {
      configuration.FIRST_PARTY_MCP_ORIGINS = [];

      const response = await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));

      expect(response.status).toBe(201);
      expect(await firstPartyOf('memory')).toBe(false);
    });
  });

  describe('when a save keeps or loses it', () => {
    beforeEach(async () => {
      const response = await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(response.status).toBe(201);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('keeps it through a save that leaves the URL and the designation alone', async () => {
      const response = await save(
        'PUT',
        manifestOf('memory', { url: MEMORY_URL, memory_provider: true, description: 'Reworded.' }),
      );

      expect(response.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('keeps it when the URL moves to another bank on the same listed origin', async () => {
      const response = await save('PUT', manifestOf('memory', { url: OTHER_BANK_URL, memory_provider: true }));

      expect(response.status).toBe(200);
      expect((await store.getServer({ tenant_id: TENANT_ID, name: 'memory' }))?.manifest.url).toBe(OTHER_BANK_URL);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('clears it when the URL moves to an origin that is not listed, and a save back marks it again', async () => {
      const moved = await save('PUT', manifestOf('memory', { url: ATTACKER_URL, memory_provider: true }));
      expect(moved.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(false);

      const back = await save('PUT', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(back.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('clears it when the connector stops being the memory provider', async () => {
      const response = await save('PUT', manifestOf('memory', { url: MEMORY_URL }));

      expect(response.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(false);
    });

    it('is gone with the connector, so a connector created again under the name starts from setup', async () => {
      await router.request('/memory', { method: 'DELETE' });
      expect(await firstPartyOf('memory')).toBeUndefined();

      await save('POST', manifestOf('memory', { url: OTHER_BANK_URL }));
      expect(await firstPartyOf('memory')).toBe(false);
    });
  });

  describe('when the operator changes the list', () => {
    it('does not mark a provider saved earlier just because its origin is now listed; saving it again does', async () => {
      configuration.FIRST_PARTY_MCP_ORIGINS = [];
      await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(await firstPartyOf('memory')).toBe(false);

      configuration.FIRST_PARTY_MCP_ORIGINS = [LISTED_ORIGIN];
      expect(await firstPartyOf('memory')).toBe(false);
      expect(await firstPartyForTurn('memory')).toBe(false);

      await save('PUT', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(await firstPartyForTurn('memory')).toBe(true);
    });

    it('stops treating a provider as first-party for a turn once its origin is removed, with no save', async () => {
      await save('POST', manifestOf('memory', { url: MEMORY_URL, memory_provider: true }));
      expect(await firstPartyForTurn('memory')).toBe(true);

      configuration.FIRST_PARTY_MCP_ORIGINS = [];

      expect(await firstPartyForTurn('memory')).toBe(false);
      expect(await firstPartyOf('memory')).toBe(true);

      configuration.FIRST_PARTY_MCP_ORIGINS = ['https://other.example.com'];
      expect(await firstPartyForTurn('memory')).toBe(false);

      configuration.FIRST_PARTY_MCP_ORIGINS = [LISTED_ORIGIN];
      expect(await firstPartyForTurn('memory')).toBe(true);
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
