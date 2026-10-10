/**
 * The first-party marker is the server's own mark that the product's setup provisioned a
 * connector. It rides on the stored record, so these tests drive the settings router and read the
 * record back: the wire never carries it, a request can never set it, and only the memory provider
 * setup, after its connection check passes, grants it.
 */
import winston from 'winston';
import { createSettingsMcpServersRouter } from '../../../src/apis/mcpServers';
import { TENANT_ID } from '../../../src/apis/sessions';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';

const MEMORY_URL = 'https://hindsight.example.com/mcp/aman/';
const MOVED_MEMORY_URL = 'https://hindsight.example.com/mcp/other/';
/** REST endpoint the memory provider check dials for each MCP URL above (never the MCP surface). */
const RECALL_URLS = new Set([
  'https://hindsight.example.com/v1/default/banks/aman/memories/recall',
  'https://hindsight.example.com/v1/default/banks/other/memories/recall',
]);

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
  let router: ReturnType<typeof createSettingsMcpServersRouter>;
  let store: IMcpServerWithAuthStore;
  let recallStatus = 200;

  beforeAll(async () => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (RECALL_URLS.has(url)) {
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
      resolveMcpServerStore: () => store,
      tokenStore,
      toolGrantStore: new SqliteMcpToolGrantStore(db),
      withTransaction: callback => db.transaction().execute(callback),
      logger: winston.createLogger({ silent: true }),
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
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

  async function save(method: 'POST' | 'PUT', manifest: unknown): Promise<Response> {
    return await router.request('/', jsonInit(method, { manifest }));
  }

  describe('who can grant it', () => {
    it('marks a connector first-party when it is created as the memory provider and its check passes', async () => {
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

    it('never marks a connector added by URL', async () => {
      const created = await save('POST', manifestOf('notes'));
      const replaced = await save('PUT', manifestOf('notes', { description: 'Edited.' }));

      expect([created.status, replaced.status]).toEqual([201, 200]);
      expect(await firstPartyOf('notes')).toBe(false);
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

  describe('when it is lost', () => {
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

    it('clears it when the URL changes, even though the new URL passes the check', async () => {
      const response = await save('PUT', manifestOf('memory', { url: MOVED_MEMORY_URL, memory_provider: true }));

      expect(response.status).toBe(200);
      expect((await store.getServer({ tenant_id: TENANT_ID, name: 'memory' }))?.manifest.url).toBe(MOVED_MEMORY_URL);
      expect(await firstPartyOf('memory')).toBe(false);
    });

    it('clears it when the connector stops being the memory provider', async () => {
      const response = await save('PUT', manifestOf('memory', { url: MEMORY_URL }));

      expect(response.status).toBe(200);
      expect(await firstPartyOf('memory')).toBe(false);
    });

    it('stays cleared after a URL change until the designation is switched off and on again', async () => {
      await save('PUT', manifestOf('memory', { url: MOVED_MEMORY_URL, memory_provider: true }));
      await save('PUT', manifestOf('memory', { url: MOVED_MEMORY_URL, memory_provider: true, description: 'Again.' }));
      expect(await firstPartyOf('memory')).toBe(false);

      await save('PUT', manifestOf('memory', { url: MOVED_MEMORY_URL }));
      await save('PUT', manifestOf('memory', { url: MOVED_MEMORY_URL, memory_provider: true }));
      expect(await firstPartyOf('memory')).toBe(true);
    });

    it('is gone with the connector, so a connector created again under the name starts from setup', async () => {
      await router.request('/memory', { method: 'DELETE' });
      expect(await firstPartyOf('memory')).toBeUndefined();

      await save('POST', manifestOf('memory', { url: MOVED_MEMORY_URL }));
      expect(await firstPartyOf('memory')).toBe(false);
    });
  });
});
