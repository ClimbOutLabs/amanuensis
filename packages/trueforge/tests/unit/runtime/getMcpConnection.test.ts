import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { mcpOAuthCallbackUrl } from '../../../src/mcp/auth/mcpOAuthHelpers';
import { getMcpConnection } from '../../../src/runtime/sessionResources';

describe('getMcpConnection', () => {
  let db: ReturnType<typeof createSqliteDb>;
  let mcpServerStore: IMcpServerWithAuthStore;
  let tokenStore: SqliteOAuthTokenStore;

  beforeAll(async () => {
    db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    tokenStore = new SqliteOAuthTokenStore(db);
    mcpServerStore = new McpServerWithAuthStore({
      store: new SqliteMcpServerStore(db),
      tokenStore,
      clientName: 'test-client',
    });
  });

  it('returns an async DCR headers resolver keyed by server name on authRequired', async () => {
    const asOrigin = 'https://auth.example.com';
    const mcpUrl = 'https://mcp.oauth.example/sse';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: mcpUrl, authorization_servers: [asOrigin] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: asOrigin,
            authorization_endpoint: `${asOrigin}/authorize`,
            token_endpoint: `${asOrigin}/token`,
            registration_endpoint: `${asOrigin}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/register') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            client_id: 'dyn-client-1',
            client_secret: 'dyn-secret-1',
            token_endpoint_auth_method: 'client_secret_post',
            redirect_uris: [mcpOAuthCallbackUrl()],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    }) as typeof fetch;

    try {
      const record = await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'oauth-mcp',
        manifest: {
          type: 'remote',
          name: 'oauth-mcp',
          url: mcpUrl,
          description: 'OAuth MCP server.',
          auth: { type: 'dcr' },
        },
        first_party: false,
      });

      const connection = await getMcpConnection({
        tenant_id: 'default',
        name: 'oauth-mcp',
        store: mcpServerStore,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      });
      expect(connection).toBeDefined();
      if (connection === undefined) {
        throw new Error('expected connection');
      }

      expect(connection.url).toBe(mcpUrl);
      expect(typeof connection.headers).toBe('function');
      if (typeof connection.headers !== 'function') {
        throw new Error('expected async headers resolver');
      }

      const headersResult = await connection.headers();
      expect('authRequired' in headersResult).toBe(true);
      if (!('authRequired' in headersResult)) {
        throw new Error('expected authRequired');
      }
      expect(headersResult.authRequired.servers).toEqual([
        {
          id: 'oauth-mcp',
          name: 'oauth-mcp',
          auth_url: expect.stringContaining(`${asOrigin}/authorize`),
        },
      ]);
      expect(record.id).not.toBe('oauth-mcp');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('returns Bearer headers when a usable token is already stored', async () => {
    const record = await mcpServerStore.upsertServer({
      tenant_id: 'default',
      name: 'tokened-mcp',
      manifest: {
        type: 'remote',
        name: 'tokened-mcp',
        url: 'https://mcp.tokened.example/mcp',
        description: 'Tokened MCP server.',
        auth: { type: 'dcr' },
      },
      first_party: false,
    });
    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'live-access',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: null,
      },
    });

    const connection = await getMcpConnection({
      tenant_id: 'default',
      name: 'tokened-mcp',
      store: mcpServerStore,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
    });
    expect(connection).toBeDefined();
    if (connection === undefined || typeof connection.headers !== 'function') {
      throw new Error('expected async headers resolver');
    }
    await expect(connection.headers()).resolves.toEqual({
      headers: { Authorization: 'Bearer live-access' },
    });
  });

  it('returns empty static headers when the server has no auth', async () => {
    await mcpServerStore.upsertServer({
      tenant_id: 'default',
      name: 'open-mcp',
      manifest: {
        type: 'remote',
        name: 'open-mcp',
        url: 'https://mcp.open.example/mcp',
        description: 'Open MCP server.',
      },
      first_party: false,
    });

    const connection = await getMcpConnection({
      tenant_id: 'default',
      name: 'open-mcp',
      store: mcpServerStore,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
    });
    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error('expected connection');
    }

    expect(connection.url).toBe('https://mcp.open.example/mcp');
    expect(connection.headers).toEqual({});
  });

  it('returns configured static headers for header-auth servers', async () => {
    await mcpServerStore.upsertServer({
      tenant_id: 'default',
      name: 'header-mcp',
      manifest: {
        type: 'remote',
        name: 'header-mcp',
        url: 'https://mcp.header.example/mcp',
        description: 'Header MCP server.',
        auth: { type: 'header', headers: { Authorization: 'Bearer static-token' } },
      },
      first_party: false,
    });

    const connection = await getMcpConnection({
      tenant_id: 'default',
      name: 'header-mcp',
      store: mcpServerStore,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
    });
    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error('expected connection');
    }

    expect(connection.url).toBe('https://mcp.header.example/mcp');
    expect(connection.headers).toEqual({ Authorization: 'Bearer static-token' });
  });

  describe('truefoundry dcr mid-turn', () => {
    it('uses store resolveInvokeHeaders (async authRequired path)', async () => {
      const record = {
        id: 'mcp-id-1',
        tenant_id: 'default',
        name: 'tfy-mcp',
        manifest: {
          type: 'truefoundry' as const,
          name: 'tfy-mcp',
          url: 'https://gateway.example/mcp-server/tfy-mcp',
          description: 'TrueFoundry-managed MCP.',
          auth: { type: 'dcr' as const },
        },
        first_party: false,
        created_at: '2026-01-15T12:00:00.000Z',
        updated_at: '2026-01-16T12:00:00.000Z',
      };
      const store = Object.create(mcpServerStore) as IMcpServerWithAuthStore;
      store.getServer = async () => record;
      store.resolveInvokeHeaders = () => async () => ({
        authRequired: {
          servers: [{ id: 'tfy-mcp', name: 'tfy-mcp', auth_url: 'https://consent.example/authorize' }],
        },
      });

      const connection = await getMcpConnection({
        tenant_id: 'default',
        name: 'tfy-mcp',
        store,
        userRef: 'user-1',
      });
      if (connection === undefined || typeof connection.headers !== 'function') {
        throw new Error('expected async headers resolver');
      }
      await expect(connection.headers()).resolves.toEqual({
        authRequired: {
          servers: [{ id: 'tfy-mcp', name: 'tfy-mcp', auth_url: 'https://consent.example/authorize' }],
        },
      });
    });
  });

  describe('search_provider role', () => {
    async function connectionFor(name: string) {
      const connection = await getMcpConnection({
        tenant_id: 'default',
        name,
        store: mcpServerStore,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      });
      if (connection === undefined) {
        throw new Error(`expected a connection for ${name}`);
      }
      return connection;
    }

    it('reports the role, with its search tools, only for the connector the user designated, plain or OAuth', async () => {
      const base = { type: 'remote' as const, description: 'Search.' };
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'finder-mcp',
        manifest: {
          ...base,
          name: 'finder-mcp',
          url: 'https://finder.example/mcp',
          search_provider: true,
          search_tools: ['find_pages'],
        },
        first_party: false,
      });
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'finder-oauth-mcp',
        manifest: {
          ...base,
          name: 'finder-oauth-mcp',
          url: 'https://finder-oauth.example/mcp',
          auth: { type: 'dcr' },
          search_provider: true,
        },
        first_party: false,
      });
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'other-search-mcp',
        manifest: {
          ...base,
          name: 'other-search-mcp',
          url: 'https://other-search.example/mcp',
          // Not designated: a leftover list means nothing without the role.
          search_tools: ['find_pages'],
        },
        first_party: false,
      });

      expect((await connectionFor('finder-mcp')).search_provider).toEqual({ tools: ['find_pages'] });
      expect((await connectionFor('finder-oauth-mcp')).search_provider).toEqual({ tools: [] });
      expect((await connectionFor('other-search-mcp')).search_provider).toBeUndefined();
    });

    it('completes a Parallel connector added before the plumbing fields existed from the catalog, without re-adding it', async () => {
      const base = { type: 'remote' as const, description: 'Free web search and page fetch.', search_provider: true };
      // As the catalog saved it: with its search tools, and a key in the query string on one.
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'parallel-web',
        manifest: {
          ...base,
          name: 'parallel-web',
          url: 'https://search.parallel.ai/mcp',
          search_tools: ['web_search', 'web_fetch'],
        },
        first_party: false,
      });
      // As an earlier build saved it: designated, but with no search tools recorded.
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'parallel-renamed',
        manifest: { ...base, name: 'parallel-renamed', url: 'https://search.parallel.ai/mcp/?key=invented' },
        first_party: false,
      });
      const catalog = McpCatalog.loadShipped();
      for (const name of ['parallel-web', 'parallel-renamed']) {
        const connection = await connectionFor(name);
        if (connection.search_provider === undefined) {
          throw new Error(`expected ${name} to be the search provider`);
        }
        expect(
          catalog.searchProviderGrant({ url: connection.url, storedTools: connection.search_provider.tools }),
        ).toEqual({
          tools: ['web_search', 'web_fetch'],
          plumbing_fields: ['session_id', 'model_name'],
        });
      }
    });
  });

  describe('first_party marker', () => {
    const LISTED_ORIGIN = 'https://hindsight.example.com';
    const MEMORY_URL = `${LISTED_ORIGIN}/mcp/aman`;
    const originalOrigins = configuration.FIRST_PARTY_MCP_ORIGINS;

    beforeEach(() => {
      configuration.FIRST_PARTY_MCP_ORIGINS = [LISTED_ORIGIN];
    });

    afterAll(() => {
      configuration.FIRST_PARTY_MCP_ORIGINS = originalOrigins;
    });

    beforeAll(async () => {
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'plain-mcp',
        manifest: {
          type: 'remote',
          name: 'plain-mcp',
          url: 'https://mcp.plain.example/mcp',
          description: 'Plain MCP.',
        },
        first_party: false,
      });
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'plain-oauth-mcp',
        manifest: {
          type: 'remote',
          name: 'plain-oauth-mcp',
          url: 'https://mcp.plain-oauth.example/mcp',
          description: 'Plain MCP behind OAuth.',
          auth: { type: 'dcr' },
        },
        first_party: false,
      });
    });

    async function connectionFor(name: string) {
      const connection = await getMcpConnection({
        tenant_id: 'default',
        name,
        store: mcpServerStore,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      });
      if (connection === undefined) {
        throw new Error(`expected a connection for ${name}`);
      }
      return connection;
    }

    it('reports the stored marker while the operator lists the origin, so the turn resolver can tell a first-party connector from the rest', async () => {
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'memory-mcp',
        manifest: {
          type: 'remote',
          name: 'memory-mcp',
          url: MEMORY_URL,
          description: 'Memory provider.',
          memory_provider: true,
        },
        first_party: true,
      });

      expect((await connectionFor('memory-mcp')).first_party).toBe(true);
      expect((await connectionFor('plain-mcp')).first_party).toBe(false);
    });

    it('reports the marker for a connector that authenticates with OAuth too', async () => {
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'memory-oauth-mcp',
        manifest: {
          type: 'remote',
          name: 'memory-oauth-mcp',
          url: MEMORY_URL,
          description: 'Memory provider behind OAuth.',
          auth: { type: 'dcr' },
          memory_provider: true,
        },
        first_party: true,
      });

      expect((await connectionFor('memory-oauth-mcp')).first_party).toBe(true);
      expect((await connectionFor('plain-oauth-mcp')).first_party).toBe(false);
    });

    it('stops reporting the marker once the operator no longer lists the origin, without any save', async () => {
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'memory-unlisted',
        manifest: {
          type: 'remote',
          name: 'memory-unlisted',
          url: MEMORY_URL,
          description: 'Memory provider.',
          memory_provider: true,
        },
        first_party: true,
      });
      expect((await connectionFor('memory-unlisted')).first_party).toBe(true);

      configuration.FIRST_PARTY_MCP_ORIGINS = [];
      expect((await connectionFor('memory-unlisted')).first_party).toBe(false);

      configuration.FIRST_PARTY_MCP_ORIGINS = ['https://another.example.com'];
      expect((await connectionFor('memory-unlisted')).first_party).toBe(false);

      configuration.FIRST_PARTY_MCP_ORIGINS = [LISTED_ORIGIN];
      expect((await connectionFor('memory-unlisted')).first_party).toBe(true);
    });

    it('does not report a stored marker for a URL on an origin other than the listed one', async () => {
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'memory-elsewhere',
        manifest: {
          type: 'remote',
          name: 'memory-elsewhere',
          url: 'https://attacker.example.net/mcp/aman',
          description: 'Memory provider.',
          memory_provider: true,
        },
        first_party: true,
      });

      expect((await connectionFor('memory-elsewhere')).first_party).toBe(false);
    });

    it('never reports a marker the store did not set, however the operator lists the origin', async () => {
      configuration.FIRST_PARTY_MCP_ORIGINS = ['https://mcp.plain.example', LISTED_ORIGIN];

      expect((await connectionFor('plain-mcp')).first_party).toBe(false);
    });
  });

  it('returns undefined when the server is not registered', async () => {
    await expect(
      getMcpConnection({
        tenant_id: 'default',
        name: 'missing-mcp',
        store: mcpServerStore,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      }),
    ).resolves.toBeUndefined();
  });
});
