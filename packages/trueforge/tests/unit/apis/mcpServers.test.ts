import winston from 'winston';
import { createCatalogRouter } from '../../../src/apis/catalog';
import { createMcpServersRouter, createSettingsMcpServersRouter } from '../../../src/apis/mcpServers';
import { TENANT_ID } from '../../../src/apis/sessions';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpCatalog } from '../../../src/catalog/McpCatalog';
import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
import { SandboxCatalog } from '../../../src/catalog/SandboxCatalog';
import { SkillCatalog } from '../../../src/catalog/SkillCatalog';
import configuration from '../../../src/config';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import type { IMcpServerWithAuthStore } from '../../../src/db/mcpServerStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { mcpOAuthCallbackUrl } from '../../../src/mcp/auth/mcpOAuthHelpers';
import {
  INERT_ASK_MEMORY_TOOL,
  INERT_ECHO_TOOL,
  INERT_READ_TOOL,
  INERT_SEARCH_MEMORY_TOOL,
  INERT_UNANNOTATED_TOOL,
  INERT_WRITE_TOOL,
  startInertMcpServer,
} from '../../fixtures/inertMcpServer';

const putBody = {
  type: 'remote' as const,
  name: 'deepwiki',
  url: 'https://mcp.deepwiki.com/mcp',
  description: 'DeepWiki MCP server.',
};

const putBodyWithDcr = {
  type: 'remote' as const,
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  description: 'Linear MCP server.',
  auth: { type: 'dcr' as const },
};

const HEADER_TOKEN = 'Bearer test-token';
/** Wire form of HEADER_TOKEN: the fixed mask, with no prefix or suffix of the secret. */
const HEADER_TOKEN_REDACTED = '***REDACTED***';

const putBodyWithHeaderAuth = {
  type: 'remote' as const,
  name: 'private-mcp',
  url: 'https://mcp.example.com/mcp',
  description: 'Private MCP server.',
  auth: {
    type: 'header' as const,
    headers: { Authorization: HEADER_TOKEN },
  },
};

const putBodyWithHeaderAuthWire = {
  ...putBodyWithHeaderAuth,
  auth: {
    type: 'header' as const,
    headers: { Authorization: HEADER_TOKEN_REDACTED },
  },
};

/** Seeded and removed inside one test: the memory-provider flag is exclusive across this suite. */
const PROVIDER_TOOLS_LISTING_NAME = 'tools-listing-memory-provider-mcp';

const HINDSIGHT_MCP_URL = 'https://hindsight.example.com/mcp/aman/';
/** REST endpoint the memory-provider check dials for HINDSIGHT_MCP_URL (never the MCP surface). */
const HINDSIGHT_RECALL_URL = 'https://hindsight.example.com/v1/default/banks/aman/memories/recall';

function memoryRecallResponse(body: unknown = { results: [], entities: {} }, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-length': String(Buffer.byteLength(text, 'utf8')), 'content-type': 'application/json' },
  });
}

/**
 * Recall answers for the save-time check; a test overrides this to script a provider failure, or
 * to land a concurrent write in the window the check holds open.
 */
let hindsightRecall: () => Response | Promise<Response> = () => memoryRecallResponse();
const hindsightRecallCalls: string[] = [];
/** The request options each save-time check was dialed with, in order. */
const hindsightRecallInits: (RequestInit | undefined)[] = [];

function wrapManifest(manifest: unknown) {
  return { manifest };
}

function configured(manifest: { name: string } & Record<string, unknown>, status: string) {
  return {
    name: manifest.name,
    manifest,
    auth_status: { status },
  };
}

function putInit(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('mcp-servers routers', () => {
  let settingsRouter: ReturnType<typeof createSettingsMcpServersRouter>;
  let catalogRouter: ReturnType<typeof createCatalogRouter>;
  let mcpServersRouter: ReturnType<typeof createMcpServersRouter>;
  let mcpServerStore: IMcpServerWithAuthStore;
  let tokenStore: SqliteOAuthTokenStore;
  let toolGrantStore: SqliteMcpToolGrantStore;
  let withTransaction: <T>(callback: (transaction: unknown) => Promise<T>) => Promise<T>;
  let logger: ReturnType<typeof winston.createLogger>;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Eager DCR dials the authorization server. Fail that outbound call fast so hermetic tests
    // without an OAuth mock hit the "DCR before write" path and must not create rows. Two
    // exceptions: the memory provider's REST recall endpoint, which the save-time check dials,
    // and loopback, where this suite's own MCP fixture listens.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === HINDSIGHT_RECALL_URL) {
        hindsightRecallCalls.push(url);
        hindsightRecallInits.push(init);
        return await hindsightRecall();
      }
      if (new URL(url).hostname === '127.0.0.1') {
        return await originalFetch(input, init);
      }
      throw new Error('network disabled in tests');
    }) as typeof fetch;
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    tokenStore = new SqliteOAuthTokenStore(db);
    toolGrantStore = new SqliteMcpToolGrantStore(db);
    mcpServerStore = new McpServerWithAuthStore({
      store: new SqliteMcpServerStore(db),
      tokenStore,
      clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
    });
    withTransaction = callback => db.transaction().execute(callback);
    logger = winston.createLogger({ silent: true });
    settingsRouter = createSettingsMcpServersRouter({
      resolveMcpServerStore: () => mcpServerStore,
      tokenStore,
      toolGrantStore,
      withTransaction,
      logger,
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
    catalogRouter = createCatalogRouter({
      modelCatalog: ModelCatalog.load(),
      mcpCatalog: McpCatalog.load(),
      skillCatalog: SkillCatalog.load(),
      sandboxCatalog: SandboxCatalog.load(),
    });
    mcpServersRouter = createMcpServersRouter({
      resolveMcpServerStore: () => mcpServerStore,
      tokenStore,
      toolGrantStore,
      withTransaction,
      logger,
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
    });
  });

  /** Persist a DCR server + stub client without calling the authorization server. */
  async function seedDcrServerWithClient(body: typeof putBodyWithDcr = putBodyWithDcr) {
    const record = await mcpServerStore.upsertServer({
      tenant_id: 'default',
      name: body.name,
      manifest: body,
      first_party: false,
    });
    await mcpServerStore.saveClient({
      id: record.id,
      record: {
        server: {
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          codeChallengeMethodsSupported: ['S256'],
        },
        client: {
          clientId: 'seed-client',
          clientSecret: 'seed-secret',
        },
      },
    });
    return record;
  }

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('GET /{name}/tools shows a memory provider full surface, including the tools the model is not given', async () => {
    // The turn resolver narrows the memory provider's mount to `@read-only` because the host
    // does the retaining. This endpoint is a different path: it dials the connector directly, so
    // the user's own settings view must keep showing everything the connector actually offers.
    const inert = await startInertMcpServer();
    try {
      const name = PROVIDER_TOOLS_LISTING_NAME;
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name,
        manifest: {
          type: 'remote',
          name,
          // Seeded through the store, not the settings router: the save-time provider check dials
          // a Hindsight REST API this MCP-only fixture does not serve.
          url: `${inert.url}/aman`,
          description: 'Memory provider whose tools listing must stay complete.',
          memory_provider: true,
        },
        first_party: false,
      });

      const response = await mcpServersRouter.request(`/${name}/tools`);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { name: string }[] };
      const listed = body.data.map(tool => tool.name).sort((a, b) => a.localeCompare(b));
      expect(listed).toEqual(
        [
          INERT_ASK_MEMORY_TOOL,
          INERT_ECHO_TOOL,
          INERT_READ_TOOL,
          INERT_SEARCH_MEMORY_TOOL,
          INERT_UNANNOTATED_TOOL,
          INERT_WRITE_TOOL,
        ].sort((a, b) => a.localeCompare(b)),
      );
      // Named on their own: these two are precisely what the resolver withholds from the model,
      // so a future change that hides them here would be hiding them from the user as well.
      expect(listed).toContain(INERT_WRITE_TOOL);
      expect(listed).toContain(INERT_UNANNOTATED_TOOL);
    } finally {
      // The store is shared across this suite, and only one connector may hold the memory-provider
      // flag: leaving this row behind would 409 every later test that enables the flag elsewhere.
      await mcpServerStore.deleteServer({ tenant_id: TENANT_ID, name: PROVIDER_TOOLS_LISTING_NAME });
      await inert.close();
    }
  });

  it('GET /catalogs/mcp-servers returns the shipped catalog verbatim', async () => {
    const response = await catalogRouter.request('/mcp-servers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { name: string }[] };
    expect(body.data.map(server => server.name)).toEqual(
      McpCatalog.load()
        .list()
        .map(server => server.name),
    );
  });

  it('PUT upserts a server and returns not_required auth_status for no-auth servers', async () => {
    const response = await settingsRouter.request('/', putInit(wrapManifest(putBody)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(putBody, 'not_required'),
    });

    const list = await settingsRouter.request('/');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      data: [configured(putBody, 'not_required')],
    });
  });

  it('rejects memory tuning outside its bounds or with an unknown field', async () => {
    const bad = [
      { recall_timeout_ms: 499 },
      { recall_timeout_ms: 120_001 },
      { recall_query_window: 0 },
      { reflect_budget: 'ultra' },
      { curated_enabled: 'yes' },
      { unknown_knob: 1 },
    ];
    for (const memory_settings of bad) {
      const response = await settingsRouter.request(
        '/',
        putInit(wrapManifest({ ...putBody, name: 'memory-tuning-bad', memory_settings })),
      );
      expect(response.status).toBe(400);
    }
  });

  it('persists memory tuning on the manifest and returns it', async () => {
    const memory_settings = {
      recall_timeout_ms: 6000,
      recall_query_window: 5,
      curated_enabled: true,
      curated_max_models: 3,
      curated_max_tokens: 512,
      reflect_enabled: false,
      reflect_budget: 'low',
      reflect_max_tokens: 512,
      reflect_timeout_ms: 8000,
    };
    const name = 'memory-tuning';
    const response = await settingsRouter.request('/', putInit(wrapManifest({ ...putBody, name, memory_settings })));
    expect(response.status).toBe(200);
    const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name });
    expect(stored?.manifest.type === 'remote' ? stored.manifest.memory_settings : undefined).toEqual(memory_settings);
    await settingsRouter.request(`/${name}`, { method: 'DELETE' });
  });

  it('POST creates a server and returns 409 on name clash', async () => {
    const createBody = {
      type: 'remote' as const,
      name: 'create-only-mcp',
      url: 'https://mcp.example.com/create-only',
      description: 'Create-only MCP server.',
    };
    const created = await settingsRouter.request('/', postInit(wrapManifest(createBody)));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: configured(createBody, 'not_required'),
    });

    const clash = await settingsRouter.request('/', postInit(wrapManifest(createBody)));
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({
      error: { message: 'MCP server name already exists: create-only-mcp' },
    });
  });

  it('GET /{name} returns the configured server and 404s unknowns', async () => {
    const response = await settingsRouter.request(`/${putBody.name}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(putBody, 'not_required'),
    });

    const missing = await settingsRouter.request('/missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { message: 'MCP server not found: missing' },
    });
  });

  it('PUT with DCR fails registration without writing a server row', async () => {
    const response = await settingsRouter.request('/', putInit(wrapManifest(putBodyWithDcr)));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to discover OAuth authorization server for MCP server 'linear'",
      },
    });
    expect(await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithDcr.name })).toBeUndefined();
  });

  it('POST with DCR fails registration without writing a server row', async () => {
    const createDcr = {
      type: 'remote' as const,
      name: 'create-dcr-fail',
      url: 'https://mcp.example.com/dcr-fail',
      description: 'Create DCR fail MCP server.',
      auth: { type: 'dcr' as const },
    };
    const response = await settingsRouter.request('/', postInit(wrapManifest(createDcr)));
    expect(response.status).toBe(422);
    expect(await mcpServerStore.getServer({ tenant_id: 'default', name: createDcr.name })).toBeUndefined();
  });

  it('DCR server reads authenticated when a token row exists, auth_required once deleted', async () => {
    const record = await seedDcrServerWithClient();

    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });

    const authed = await settingsRouter.request('/');
    const authedBody = (await authed.json()) as { data: { name: string; auth_status: { status: string } }[] };
    expect(authedBody.data.find(server => server.name === putBodyWithDcr.name)?.auth_status).toEqual({
      status: 'authenticated',
    });

    // List auth_status is presence-based; expiry is handled at resolve/refresh time.
    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2000-01-01T00:00:00.000Z',
        scope: null,
      },
    });

    const expired = await settingsRouter.request('/');
    const expiredBody = (await expired.json()) as { data: { name: string; auth_status: { status: string } }[] };
    expect(expiredBody.data.find(server => server.name === putBodyWithDcr.name)?.auth_status).toEqual({
      status: 'authenticated',
    });

    await tokenStore.deleteToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id });

    const cleared = await settingsRouter.request('/');
    const clearedBody = (await cleared.json()) as { data: { name: string; auth_status: { status: string } }[] };
    expect(clearedBody.data.find(server => server.name === putBodyWithDcr.name)?.auth_status).toEqual({
      status: 'auth_required',
    });
  });

  it('PUT re-upsert of a DCR server reports authenticated when a usable token already exists', async () => {
    // Existing client skips DCR over the wire so network-disabled tests only exercise the DB path.
    const record = await seedDcrServerWithClient();

    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });

    // A re-upsert preserves the id, so the PUT response must reflect the carried-over token.
    const response = await settingsRouter.request('/', putInit(wrapManifest(putBodyWithDcr)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(putBodyWithDcr, 'authenticated'),
    });

    await tokenStore.deleteToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id });
  });

  it('PUT URL change re-registers DCR and clears tokens and pending authorizations', async () => {
    const record = await seedDcrServerWithClient();
    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'stale-for-old-url',
        refreshToken: 'stale-refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });
    await tokenStore.saveToken({
      id: record.id,
      userRef: 'other-user',
      token: {
        accessToken: 'stale-other-user',
        refreshToken: 'stale-other-refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });
    await tokenStore.savePendingAuthorization({
      state: 'stale-pending-state',
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      mcpServerUrl: putBodyWithDcr.url,
      codeVerifier: 'stale-verifier',
      returnTo: null,
    });

    const newUrl = 'https://mcp.linear.app/v2/mcp';
    const asOrigin = 'https://auth.example.com';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) {
        return new Response(JSON.stringify({ resource: newUrl, authorization_servers: [asOrigin] }), {
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
            client_id: 'new-url-client',
            client_secret: 'new-url-secret',
            token_endpoint_auth_method: 'client_secret_post',
            // Absolute URLs only — SDK parses registration responses with SafeUrlSchema.
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
      const response = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest({
            ...putBodyWithDcr,
            url: newUrl,
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: configured({ ...putBodyWithDcr, url: newUrl }, 'auth_required'),
      });
      expect(
        await tokenStore.getToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id }),
      ).toBeUndefined();
      expect(await tokenStore.getToken({ id: record.id, userRef: 'other-user' })).toBeUndefined();
      expect(await tokenStore.consumePendingAuthorization({ state: 'stale-pending-state' })).toBeUndefined();
      expect(await mcpServerStore.getClient({ id: record.id })).toMatchObject({
        client: { clientId: 'new-url-client' },
      });
    } finally {
      globalThis.fetch = realFetch;
      // Restore baseline for later suite cases that still expect original linear URL / no token.
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: putBodyWithDcr.name,
        manifest: putBodyWithDcr,
        first_party: false,
      });
      await mcpServerStore.saveClient({
        id: record.id,
        record: {
          server: {
            authorizationEndpoint: 'https://auth.example.com/authorize',
            tokenEndpoint: 'https://auth.example.com/token',
            codeChallengeMethodsSupported: ['S256'],
          },
          client: {
            clientId: 'seed-client',
            clientSecret: 'seed-secret',
          },
        },
      });
    }
  });

  it('PUT with header auth stores plaintext and returns redacted headers', async () => {
    const response = await settingsRouter.request('/', putInit(wrapManifest(putBodyWithHeaderAuth)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(putBodyWithHeaderAuthWire, 'authenticated'),
    });

    const stored = await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithHeaderAuth.name });
    expect(stored?.manifest.auth).toEqual(putBodyWithHeaderAuth.auth);
  });

  it('PUT create with a redacted header value returns 400', async () => {
    const redactedOnly = {
      ...putBodyWithHeaderAuth,
      name: 'redacted-only-mcp',
      auth: {
        type: 'header' as const,
        headers: { Authorization: HEADER_TOKEN_REDACTED },
      },
    };
    const response = await settingsRouter.request('/', putInit(wrapManifest(redactedOnly)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'Header secret is required' } });
  });

  it('PUT with a redacted header value keeps the stored secret', async () => {
    await settingsRouter.request('/', putInit(wrapManifest(putBodyWithHeaderAuth)));

    const keep = {
      ...putBodyWithHeaderAuth,
      url: 'https://mcp.example.com/v2/mcp',
      auth: {
        type: 'header' as const,
        headers: { Authorization: HEADER_TOKEN_REDACTED },
      },
    };
    const response = await settingsRouter.request('/', putInit(wrapManifest(keep)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(
        {
          ...keep,
          auth: {
            type: 'header',
            headers: { Authorization: HEADER_TOKEN_REDACTED },
          },
        },
        'authenticated',
      ),
    });

    const stored = await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithHeaderAuth.name });
    expect(stored?.manifest).toEqual({
      ...putBodyWithHeaderAuth,
      url: keep.url,
      auth: putBodyWithHeaderAuth.auth,
    });
  });

  it('PUT with a different redacted header value still keeps the stored secret', async () => {
    await settingsRouter.request('/', putInit(wrapManifest(putBodyWithHeaderAuth)));

    // Any value containing ***REDACTED*** is treated as keep, so masks from older GETs still round-trip.
    const keep = {
      ...putBodyWithHeaderAuth,
      url: 'https://mcp.example.com/v3/mcp',
      auth: {
        type: 'header' as const,
        headers: { Authorization: 'oth-***REDACTED***-xxx' },
      },
    };
    const response = await settingsRouter.request('/', putInit(wrapManifest(keep)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(
        {
          ...keep,
          auth: {
            type: 'header',
            headers: { Authorization: HEADER_TOKEN_REDACTED },
          },
        },
        'authenticated',
      ),
    });

    const stored = await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithHeaderAuth.name });
    expect(stored?.manifest).toEqual({
      ...putBodyWithHeaderAuth,
      url: keep.url,
      auth: putBodyWithHeaderAuth.auth,
    });
  });

  it('PUT with a real header value rotates the stored secret', async () => {
    await settingsRouter.request('/', putInit(wrapManifest(putBodyWithHeaderAuth)));

    const rotatedToken = 'Bearer rotated-token';
    const rotatedTokenRedacted = '***REDACTED***';
    const rotated = {
      ...putBodyWithHeaderAuth,
      auth: {
        type: 'header' as const,
        headers: { Authorization: rotatedToken },
      },
    };
    const response = await settingsRouter.request('/', putInit(wrapManifest(rotated)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(
        {
          ...rotated,
          auth: {
            type: 'header',
            headers: { Authorization: rotatedTokenRedacted },
          },
        },
        'authenticated',
      ),
    });

    const stored = await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithHeaderAuth.name });
    expect(stored?.manifest.auth).toEqual(rotated.auth);
  });

  describe('header auth with a secret reference value', () => {
    const REF_ENV_VAR = 'MCP_SERVERS_TEST_REFERENCE_TOKEN';

    afterEach(() => {
      delete process.env[REF_ENV_VAR];
    });

    it('PUT with a secret reference stores and returns it unredacted (it is a pointer, not a secret)', async () => {
      process.env[REF_ENV_VAR] = 'plaintext-secret-must-never-be-stored';
      const referenceBody = {
        type: 'remote' as const,
        name: 'reference-mcp',
        url: 'https://mcp.example.com/reference',
        description: 'Reference-auth MCP server.',
        auth: { type: 'header' as const, headers: { Authorization: `\${env:${REF_ENV_VAR}}` } },
      };

      const response = await settingsRouter.request('/', putInit(wrapManifest(referenceBody)));
      expect(response.status).toBe(200);
      // Unredacted in the wire response: a reference is safe to display and edit as-is.
      expect(await response.json()).toEqual({ data: configured(referenceBody, 'authenticated') });

      const get = await settingsRouter.request(`/${referenceBody.name}`);
      expect(await get.json()).toEqual({ data: configured(referenceBody, 'authenticated') });

      // Store round-trip: the persisted document carries the reference string verbatim, and the
      // secret it points at never appears in it.
      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: referenceBody.name });
      expect(stored?.manifest.auth).toEqual(referenceBody.auth);
      const persistedDocument = JSON.stringify(stored?.manifest);
      expect(persistedDocument).toContain(`\${env:${REF_ENV_VAR}}`);
      expect(persistedDocument).not.toContain('plaintext-secret-must-never-be-stored');
    });

    it('PUT with a literal header value later replaced by a reference stores the reference, not the literal', async () => {
      const literalBody = {
        type: 'remote' as const,
        name: 'literal-then-reference-mcp',
        url: 'https://mcp.example.com/literal-then-reference',
        description: 'Starts literal, becomes a reference.',
        auth: { type: 'header' as const, headers: { Authorization: 'Bearer literal-token-value' } },
      };
      await settingsRouter.request('/', putInit(wrapManifest(literalBody)));

      const referenceBody = {
        ...literalBody,
        auth: { type: 'header' as const, headers: { Authorization: `\${env:${REF_ENV_VAR}}` } },
      };
      const response = await settingsRouter.request('/', putInit(wrapManifest(referenceBody)));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: configured(referenceBody, 'authenticated') });

      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: literalBody.name });
      expect(stored?.manifest.auth).toEqual(referenceBody.auth);
      expect(JSON.stringify(stored?.manifest)).not.toContain('literal-token-value');
    });

    it('PUT with a new reference replaces a previously stored reference (no redacted-stand-in confusion)', async () => {
      const firstReference = {
        type: 'remote' as const,
        name: 'reference-rotation-mcp',
        url: 'https://mcp.example.com/reference-rotation',
        description: 'Reference rotated to another reference.',
        auth: { type: 'header' as const, headers: { Authorization: `\${env:${REF_ENV_VAR}}` } },
      };
      await settingsRouter.request('/', putInit(wrapManifest(firstReference)));

      const secondReference = {
        ...firstReference,
        auth: { type: 'header' as const, headers: { Authorization: '${file:/data/secrets/other-token}' } },
      };
      const response = await settingsRouter.request('/', putInit(wrapManifest(secondReference)));
      expect(response.status).toBe(200);
      // A reference never contains the redaction sentinel, so this is an ordinary value change —
      // not treated as a "keep the stored secret" no-op.
      expect(await response.json()).toEqual({ data: configured(secondReference, 'authenticated') });

      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: firstReference.name });
      expect(stored?.manifest.auth).toEqual(secondReference.auth);
    });

    it('GET /{name}/tools surfaces a clear, value-free error when the referenced env var is missing', async () => {
      delete process.env[REF_ENV_VAR];
      const brokenBody = {
        type: 'remote' as const,
        name: 'broken-reference-mcp',
        url: 'https://mcp.example.com/broken-reference',
        description: 'References a variable that is not set.',
        auth: { type: 'header' as const, headers: { Authorization: `\${env:${REF_ENV_VAR}}` } },
      };
      await settingsRouter.request('/', putInit(wrapManifest(brokenBody)));

      // Same getMcpConnection choke point as turn execution; the resolver rejects before any
      // network call, so this needs no live/mocked MCP transport to observe the degraded behavior.
      const response = await mcpServersRouter.request(`/${brokenBody.name}/tools`);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('Authorization');
      expect(body.error.message).toContain(`\${env:${REF_ENV_VAR}}`);
    });
  });

  it('GET / on the chat router returns per-user auth_status and public auth type', async () => {
    const response = await mcpServersRouter.request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        name: string;
        url: string;
        auth?: { type: string };
        auth_status: { status: string };
      }[];
    };
    const byName = new Map(body.data.map(server => [server.name, server]));

    expect(byName.get('deepwiki')).toEqual({
      name: 'deepwiki',
      url: putBody.url,
      auth_status: { status: 'not_required' },
    });
    expect(byName.get('linear')).toEqual({
      name: 'linear',
      url: putBodyWithDcr.url,
      auth: { type: 'dcr' },
      auth_status: { status: 'auth_required' },
    });
    expect(byName.get('private-mcp')).toEqual({
      name: 'private-mcp',
      url: putBodyWithHeaderAuth.url,
      auth: { type: 'header' },
      auth_status: { status: 'authenticated' },
    });
  });

  it('GET / omits the memory provider from the chat list while settings still shows it', async () => {
    // The host owns recall and retention for this connector, so attaching it to a chat has no
    // upside; it is filtered out of the chat projection rather than left for a user to avoid.
    const name = 'chat-hidden-memory-provider-mcp';
    try {
      await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name,
        manifest: {
          type: 'remote',
          name,
          url: 'https://hindsight.example.com/mcp/hidden/',
          description: 'Memory provider that must not be offered in chats.',
          memory_provider: true,
        },
        first_party: false,
      });

      const chat = await mcpServersRouter.request('/');
      expect(chat.status).toBe(200);
      const chatBody = (await chat.json()) as { data: { name: string }[] };
      const chatNames = chatBody.data.map(server => server.name);
      expect(chatNames).not.toContain(name);
      // A connector without the flag is untouched by the filter, so the picker still has content.
      expect(chatNames).toContain(putBody.name);
      expect(chatNames).toContain(putBodyWithDcr.name);

      const settings = await settingsRouter.request('/');
      expect(settings.status).toBe(200);
      const settingsBody = (await settings.json()) as { data: { name: string }[] };
      // Still fully present where it is configured, flagged, tested, and its tools are listed.
      expect(settingsBody.data.map(server => server.name)).toContain(name);
    } finally {
      // Shared store, exclusive flag: leaving this row behind would 409 later enable-elsewhere tests.
      await mcpServerStore.deleteServer({ tenant_id: TENANT_ID, name });
    }
  });

  it('GET /{name} on the chat router returns the slim projection with live auth_status', async () => {
    const missing = await mcpServersRouter.request('/missing-server');
    expect(missing.status).toBe(404);

    const noAuth = await mcpServersRouter.request('/deepwiki');
    expect(noAuth.status).toBe(200);
    expect(await noAuth.json()).toEqual({
      data: {
        name: 'deepwiki',
        url: putBody.url,
        auth_status: { status: 'not_required' },
      },
    });

    const dcr = await mcpServersRouter.request('/linear');
    expect(dcr.status).toBe(200);
    expect(await dcr.json()).toEqual({
      data: {
        name: 'linear',
        url: putBodyWithDcr.url,
        auth: { type: 'dcr' },
        auth_status: { status: 'auth_required' },
      },
    });

    const headerAuth = await mcpServersRouter.request('/private-mcp');
    expect(headerAuth.status).toBe(200);
    expect(await headerAuth.json()).toEqual({
      data: {
        name: 'private-mcp',
        url: putBodyWithHeaderAuth.url,
        auth: { type: 'header' },
        auth_status: { status: 'authenticated' },
      },
    });
  });

  it('GET / chat list auth_status is scoped to the calling user', async () => {
    const record = await mcpServerStore.getServer({ tenant_id: 'default', name: putBodyWithDcr.name });
    if (record === undefined) throw new Error('expected DCR server to exist');
    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });

    const forLocal = await mcpServersRouter.request('/');
    const localBody = (await forLocal.json()) as {
      data: { name: string; auth_status: { status: string } }[];
    };
    expect(localBody.data.find(server => server.name === putBodyWithDcr.name)?.auth_status).toEqual({
      status: 'authenticated',
    });

    const otherRouter = createMcpServersRouter({
      resolveMcpServerStore: () => mcpServerStore,
      tokenStore,
      toolGrantStore,
      withTransaction,
      logger,
      resolveRequestContext: () => ({
        tenant_id: 'default',
        subject: { id: 'other-user', type: 'user', display_name: 'other-user' },
        roles: [],
        user_credential: null,
      }),
    });
    const forOther = await otherRouter.request('/');
    const otherBody = (await forOther.json()) as {
      data: { name: string; auth_status: { status: string } }[];
    };
    expect(otherBody.data.find(server => server.name === putBodyWithDcr.name)?.auth_status).toEqual({
      status: 'auth_required',
    });

    await tokenStore.deleteToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id });
  });

  it('PUT rejects invalid bodies at the Zod layer', async () => {
    const { url: _, ...withoutUrl } = putBody;
    const missingUrl = await settingsRouter.request('/', putInit(wrapManifest(withoutUrl)));
    expect(missingUrl.status).toBe(400);

    const badName = await settingsRouter.request('/', putInit(wrapManifest({ ...putBody, name: 'Not A Name' })));
    expect(badName.status).toBe(400);

    const emptyHeaders = await settingsRouter.request(
      '/',
      putInit(
        wrapManifest({
          ...putBodyWithHeaderAuth,
          name: 'bad-empty-headers',
          auth: { type: 'header', headers: {} },
        }),
      ),
    );
    expect(emptyHeaders.status).toBe(400);
  });

  it('GET /{name}/authorize short-circuits non-DCR servers and 404s unknowns', async () => {
    const noAuth = await mcpServersRouter.request('/deepwiki/authorize?return_to=/settings');
    expect(noAuth.status).toBe(200);
    expect(await noAuth.json()).toEqual({ status: 'not_required' });

    const headerAuth = await mcpServersRouter.request('/private-mcp/authorize?return_to=/settings');
    expect(headerAuth.status).toBe(200);
    expect(await headerAuth.json()).toEqual({ status: 'authenticated' });

    const missing = await mcpServersRouter.request('/missing/authorize?return_to=/settings');
    expect(missing.status).toBe(404);
  });

  it('GET /{name}/authorize rejects unsafe return_to values with 400', async () => {
    await seedDcrServerWithClient();

    for (const returnTo of [
      'https://evil.example.com/phish',
      '//evil.example.com/phish',
      '/api/v1/sessions',
      '/api',
      'relative-not-absolute',
    ]) {
      const response = await mcpServersRouter.request(
        `/${putBodyWithDcr.name}/authorize?return_to=${encodeURIComponent(returnTo)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { message: 'Invalid return_to: must be a same-origin relative path' },
      });
    }
  });

  it('GET /{name}/authorize returns 424 when upstream DCR registration fails', async () => {
    const asOrigin = 'https://auth-failure.example.com';
    const mcpUrl = 'https://mcp-failure.example.com/sse';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async input => {
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
      if (url.includes('/register')) {
        return new Response('upstream unavailable', { status: 500 });
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    }) as typeof fetch;

    try {
      const put = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest({
            type: 'remote',
            name: 'failing-oauth-mcp',
            url: mcpUrl,
            description: 'Failing OAuth MCP server.',
            auth: { type: 'dcr' },
          }),
        ),
      );
      // Registration fails before any DB write — no server exists to authorize.
      expect(put.status).toBe(422);
      expect(await mcpServerStore.getServer({ tenant_id: 'default', name: 'failing-oauth-mcp' })).toBeUndefined();

      const authorize = await mcpServersRouter.request('/failing-oauth-mcp/authorize');
      expect(authorize.status).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('GET /{name}/authorize for DCR returns auth_required with an authorization_url', async () => {
    const asOrigin = 'https://auth.example.com';
    const mcpUrl = 'https://mcp.example.com/sse';
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
      const put = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest({
            type: 'remote',
            name: 'oauth-mcp',
            url: mcpUrl,
            description: 'OAuth MCP server.',
            auth: { type: 'dcr' },
          }),
        ),
      );
      expect(put.status).toBe(200);

      const authorize = await mcpServersRouter.request('/oauth-mcp/authorize?return_to=/settings/after-oauth');
      expect(authorize.status).toBe(200);
      const body = (await authorize.json()) as { status: string; authorization_url?: string };
      expect(body.status).toBe('auth_required');
      expect(body.authorization_url).toBeDefined();
      const authUrl = new URL(body.authorization_url ?? '');
      expect(authUrl.origin).toBe(asOrigin);
      expect(authUrl.searchParams.get('client_id')).toBe('dyn-client-1');
      expect(authUrl.searchParams.get('state')).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('DELETE /{name}/authorize removes the DCR token, keeps the client, and reports auth_required', async () => {
    const record = await seedDcrServerWithClient();

    await mcpServerStore.saveClient({
      id: record.id,
      record: {
        server: {
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/token',
          codeChallengeMethodsSupported: ['S256'],
        },
        client: {
          clientId: 'keep-me',
          clientSecret: 'keep-secret',
        },
      },
    });
    await tokenStore.saveToken({
      id: record.id,
      userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
      token: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        scope: null,
      },
    });

    const response = await mcpServersRouter.request(`/${putBodyWithDcr.name}/authorize`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: configured(putBodyWithDcr, 'auth_required'),
    });
    expect(
      await tokenStore.getToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id }),
    ).toBeUndefined();
    expect(await mcpServerStore.getClient({ id: record.id })).toEqual({
      server: {
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        codeChallengeMethodsSupported: ['S256'],
      },
      client: {
        clientId: 'keep-me',
        clientSecret: 'keep-secret',
      },
    });
  });

  it('DELETE /{name}/authorize is a no-op for non-DCR servers and 404s unknowns', async () => {
    const noAuth = await mcpServersRouter.request('/deepwiki/authorize', { method: 'DELETE' });
    expect(noAuth.status).toBe(200);
    expect(await noAuth.json()).toEqual({
      data: configured(putBody, 'not_required'),
    });

    // Ensure header-auth fixture is present with a known secret (later tests may have rotated it).
    await settingsRouter.request('/', putInit(wrapManifest(putBodyWithHeaderAuth)));
    const headerAuth = await mcpServersRouter.request('/private-mcp/authorize', { method: 'DELETE' });
    expect(headerAuth.status).toBe(200);
    expect(await headerAuth.json()).toEqual({
      data: configured(putBodyWithHeaderAuthWire, 'authenticated'),
    });

    const missing = await mcpServersRouter.request('/missing/authorize', { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  describe('memory provider single-flag enforcement', () => {
    const hindsightUrl = HINDSIGHT_MCP_URL;

    function hindsightManifest(name: string, extra: Record<string, unknown> = {}) {
      return {
        type: 'remote' as const,
        name,
        url: hindsightUrl,
        description: `Hindsight connector "${name}".`,
        ...extra,
      };
    }

    afterEach(() => {
      hindsightRecall = () => memoryRecallResponse();
    });

    it('PUT creates the first memory provider without conflict', async () => {
      const response = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-primary', { memory_provider: true }))),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: configured(hindsightManifest('hindsight-primary', { memory_provider: true }), 'not_required'),
      });
    });

    it('POST create rejects a second memory provider with 409 naming the existing one', async () => {
      const response = await settingsRouter.request(
        '/',
        postInit(wrapManifest(hindsightManifest('hindsight-secondary', { memory_provider: true }))),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { message: 'memory provider already set on hindsight-primary; disable it first' },
      });
      expect(await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-secondary' })).toBeUndefined();
    });

    it('PUT rejects flagging a second, already-existing server as memory provider with 409', async () => {
      // hindsight-secondary exists without the flag so this exercises the update path.
      const created = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-secondary'))),
      );
      expect(created.status).toBe(200);

      const response = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-secondary', { memory_provider: true }))),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { message: 'memory provider already set on hindsight-primary; disable it first' },
      });

      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-secondary' });
      expect(stored?.manifest.type === 'remote' ? stored.manifest.memory_provider : undefined).toBeUndefined();
    });

    it('PUT re-saving the server that already holds the flag is not a conflict with itself', async () => {
      const response = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest(
            hindsightManifest('hindsight-primary', { memory_provider: true, description: 'Updated description.' }),
          ),
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { name: 'hindsight-primary', manifest: { memory_provider: true } },
      });
    });

    it('supports the two-step UI flow: disable on the holder, then enable on another connector', async () => {
      const disable = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-primary', { description: 'Updated description.' }))),
      );
      expect(disable.status).toBe(200);
      const disableBody = (await disable.json()) as { data: { manifest: { memory_provider?: boolean } } };
      expect(disableBody.data.manifest.memory_provider).toBeUndefined();

      const enable = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-secondary', { memory_provider: true }))),
      );
      expect(enable.status).toBe(200);
      expect(await enable.json()).toMatchObject({
        data: { name: 'hindsight-secondary', manifest: { memory_provider: true } },
      });
    });
  });

  describe('memory provider connection check', () => {
    const REST_401_DETAIL = 'Authentication failed: Invalid API key';

    function hindsightManifest(name: string, extra: Record<string, unknown> = {}) {
      return {
        type: 'remote' as const,
        name,
        url: HINDSIGHT_MCP_URL,
        description: `Hindsight connector "${name}".`,
        ...extra,
      };
    }

    function rejectRestWith401(): void {
      hindsightRecall = () => memoryRecallResponse({ detail: REST_401_DETAIL }, 401);
    }

    beforeAll(async () => {
      // Neutralize whichever connector still holds the flag from the suite above, so these
      // tests' own flagged connectors are checked rather than rejected as a duplicate provider.
      const existing = await mcpServerStore.listServers({ tenant_id: TENANT_ID, names: undefined });
      for (const holder of existing.filter(
        (server): server is typeof server & { manifest: { type: 'remote'; memory_provider: true } } =>
          server.manifest.type === 'remote' && server.manifest.memory_provider === true,
      )) {
        const { memory_provider: _flag, ...withoutFlag } = holder.manifest;
        await mcpServerStore.upsertServer({
          tenant_id: TENANT_ID,
          name: holder.name,
          manifest: withoutFlag,
          first_party: false,
        });
      }
    });

    afterEach(() => {
      hindsightRecall = () => memoryRecallResponse();
    });

    it('rejects a PUT that flags a provider whose REST API refuses the credential, and writes nothing', async () => {
      rejectRestWith401();

      const response = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-rest-401', { memory_provider: true }))),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { message: `memory provider check failed: recall returned HTTP 401: ${REST_401_DETAIL}` },
      });
      expect(await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-rest-401' })).toBeUndefined();
    });

    it('rejects a create the same way, naming the upstream reason', async () => {
      rejectRestWith401();

      const response = await settingsRouter.request(
        '/',
        postInit(wrapManifest(hindsightManifest('hindsight-create-401', { memory_provider: true }))),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { message: `memory provider check failed: recall returned HTTP 401: ${REST_401_DETAIL}` },
      });
      expect(await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-create-401' })).toBeUndefined();
    });

    it.each([
      ['PUT', putInit],
      ['POST', postInit],
    ])(
      'rejects a %s whose provider answers the check with a redirect, and does not follow it',
      async (method, init) => {
        hindsightRecall = () =>
          new Response(null, {
            status: 308,
            headers: { location: 'https://other.example.com/v1/default/banks/aman/memories/recall?key=hunter2' },
          });
        const name = `hindsight-redirect-${method.toLowerCase()}`;
        const dialed = hindsightRecallInits.length;

        const response = await settingsRouter.request(
          '/',
          init(wrapManifest(hindsightManifest(name, { memory_provider: true }))),
        );

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: {
            message:
              'memory provider check failed: recall returned HTTP 308, a redirect to https://other.example.com; redirects are not followed',
          },
        });
        expect(await mcpServerStore.getServer({ tenant_id: TENANT_ID, name })).toBeUndefined();
        expect(hindsightRecallInits.slice(dialed)).toEqual([expect.objectContaining({ redirect: 'manual' })]);
      },
    );

    it('leaves an existing provider untouched when a later edit fails the check', async () => {
      const enable = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-edit', { memory_provider: true }))),
      );
      expect(enable.status).toBe(200);

      rejectRestWith401();
      const rotate = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest(
            hindsightManifest('hindsight-edit', {
              memory_provider: true,
              auth: { type: 'header', headers: { Authorization: 'Bearer rotated-and-wrong' } },
            }),
          ),
        ),
      );

      expect(rotate.status).toBe(422);
      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-edit' });
      expect(stored?.manifest.auth).toBeUndefined();

      await settingsRouter.request(`/hindsight-edit`, { method: 'DELETE' });
    });

    it('never dials the provider for a connector that is not the memory provider', async () => {
      const before = hindsightRecallCalls.length;

      const response = await settingsRouter.request('/', putInit(wrapManifest(hindsightManifest('hindsight-plain'))));

      expect(response.status).toBe(200);
      expect(hindsightRecallCalls.length).toBe(before);

      await settingsRouter.request(`/hindsight-plain`, { method: 'DELETE' });
    });

    it('POST /{name}/memory-check reports the structured result without touching the row', async () => {
      const created = await settingsRouter.request(
        '/',
        putInit(wrapManifest(hindsightManifest('hindsight-checkable', { memory_provider: true }))),
      );
      expect(created.status).toBe(200);
      const before = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-checkable' });

      const healthy = await mcpServersRouter.request('/hindsight-checkable/memory-check', { method: 'POST' });
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ data: { status: 'ok' } });

      rejectRestWith401();
      const failed = await mcpServersRouter.request('/hindsight-checkable/memory-check', { method: 'POST' });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({
        data: {
          status: 'failed',
          code: 'http_error',
          http_status: 401,
          detail: REST_401_DETAIL,
          reason: `recall returned HTTP 401: ${REST_401_DETAIL}`,
        },
      });

      const after = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-checkable' });
      expect(after?.manifest).toEqual(before?.manifest);

      await settingsRouter.request(`/hindsight-checkable`, { method: 'DELETE' });
    });

    it('POST /{name}/memory-check reports a URL memory could never use, and 404s an unknown name', async () => {
      const created = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest({
            type: 'remote' as const,
            name: 'hindsight-bad-url',
            url: 'https://hindsight.example.com/sse',
            description: 'Connector whose URL is not a single-bank Hindsight MCP URL.',
          }),
        ),
      );
      expect(created.status).toBe(200);

      const response = await mcpServersRouter.request('/hindsight-bad-url/memory-check', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { status: 'failed', code: 'invalid_url' } });

      const missing = await mcpServersRouter.request('/nope/memory-check', { method: 'POST' });
      expect(missing.status).toBe(404);

      await settingsRouter.request(`/hindsight-bad-url`, { method: 'DELETE' });
    });

    it('rejects a header connector switched to DCR rather than passing on the header it replaces', async () => {
      const headerAuth = { type: 'header' as const, headers: { Authorization: 'Bearer accepted-by-rest' } };
      const created = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest(hindsightManifest('hindsight-header-to-dcr', { memory_provider: true, auth: headerAuth })),
        ),
      );
      expect(created.status).toBe(200);

      const before = hindsightRecallCalls.length;
      const response = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest(hindsightManifest('hindsight-header-to-dcr', { memory_provider: true, auth: { type: 'dcr' } })),
        ),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          message:
            'memory provider check failed: connector "hindsight-header-to-dcr" must be saved and authorized before it can be checked',
        },
      });
      // The header the write was about to drop is never dialed on the DCR manifest's behalf.
      expect(hindsightRecallCalls.length).toBe(before);
      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: 'hindsight-header-to-dcr' });
      expect(stored?.manifest.auth).toEqual(headerAuth);

      await settingsRouter.request('/hindsight-header-to-dcr', { method: 'DELETE' });
    });

    it('rejects a DCR URL change rather than passing on the token the write would delete', async () => {
      const dcrProvider = {
        type: 'remote' as const,
        name: 'hindsight-dcr-url',
        url: HINDSIGHT_MCP_URL,
        description: 'Authorized Hindsight DCR connector.',
        auth: { type: 'dcr' as const },
        memory_provider: true,
      };
      const record = await mcpServerStore.upsertServer({
        tenant_id: TENANT_ID,
        name: dcrProvider.name,
        manifest: dcrProvider,
        first_party: false,
      });
      await mcpServerStore.saveClient({
        id: record.id,
        record: {
          server: {
            authorizationEndpoint: 'https://auth.example.com/authorize',
            tokenEndpoint: 'https://auth.example.com/token',
            codeChallengeMethodsSupported: ['S256'],
          },
          client: { clientId: 'seed-client', clientSecret: 'seed-secret' },
        },
      });
      await tokenStore.saveToken({
        id: record.id,
        userRef: STANDALONE_REQUEST_CONTEXT.subject.id,
        token: {
          accessToken: 'access-for-the-old-url',
          refreshToken: 'refresh-1',
          expiresAt: '2099-01-01T00:00:00.000Z',
          scope: null,
        },
      });

      const before = hindsightRecallCalls.length;
      const response = await settingsRouter.request(
        '/',
        putInit(wrapManifest({ ...dcrProvider, url: 'https://hindsight.example.com/mcp/moved/' })),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          message:
            'memory provider check failed: changing the URL of "hindsight-dcr-url" clears its authorization, so it must be authorized again before it can serve memory',
        },
      });
      // A URL change deletes every token for the row, so the stored one must not vouch for it.
      expect(hindsightRecallCalls.length).toBe(before);
      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name: dcrProvider.name });
      expect(stored?.manifest.url).toBe(HINDSIGHT_MCP_URL);

      await settingsRouter.request(`/${dcrProvider.name}`, { method: 'DELETE' });
    });

    it('refuses to commit a save whose stored credential changed while the check was running', async () => {
      const name = 'hindsight-raced';
      const original = {
        type: 'remote' as const,
        name,
        url: HINDSIGHT_MCP_URL,
        description: 'Hindsight connector checked under a race.',
        memory_provider: true,
        auth: { type: 'header' as const, headers: { Authorization: 'Bearer the-probed-value' } },
      };
      const created = await settingsRouter.request('/', putInit(wrapManifest(original)));
      expect(created.status).toBe(200);

      const raced = {
        ...original,
        description: 'Rotated by a concurrent save.',
        auth: { type: 'header' as const, headers: { Authorization: 'Bearer rotated-concurrently' } },
      };
      hindsightRecall = async () => {
        // Lands after the unlocked read the check resolved from, before the write txn locks.
        await mcpServerStore.upsertServer({ tenant_id: TENANT_ID, name, manifest: raced, first_party: false });
        return memoryRecallResponse();
      };

      const response = await settingsRouter.request(
        '/',
        putInit(
          wrapManifest({
            ...original,
            description: 'Saved by the request that raced.',
            auth: { type: 'header' as const, headers: { Authorization: HEADER_TOKEN_REDACTED } },
          }),
        ),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { message: `connector "${name}" changed while its memory provider check was running; retry the save` },
      });
      // Nothing of the racing save landed: the credential it probed is no longer the stored one.
      const stored = await mcpServerStore.getServer({ tenant_id: TENANT_ID, name });
      expect(stored?.manifest).toEqual(raced);

      await settingsRouter.request(`/${name}`, { method: 'DELETE' });
    });
  });

  describe('DELETE /{name}', () => {
    it('deletes a server; a subsequent GET 404s', async () => {
      const body = {
        type: 'remote' as const,
        name: 'delete-target-mcp',
        url: 'https://mcp.example.com/delete-target',
        description: 'Server created only to be deleted.',
      };
      const put = await settingsRouter.request('/', putInit(wrapManifest(body)));
      expect(put.status).toBe(200);

      const response = await settingsRouter.request(`/${body.name}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});

      const get = await settingsRouter.request(`/${body.name}`);
      expect(get.status).toBe(404);
    });

    it('404s for an unknown name', async () => {
      const response = await settingsRouter.request('/missing-delete-target', { method: 'DELETE' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { message: 'MCP server not found: missing-delete-target' },
      });
    });

    it("purges every user's stored OAuth tokens before removing a DCR server, not just the caller's", async () => {
      const dcrBody = {
        type: 'remote' as const,
        name: 'delete-target-dcr-mcp',
        url: 'https://mcp.example.com/delete-target-dcr',
        description: 'DCR server created only to be deleted.',
        auth: { type: 'dcr' as const },
      };
      const record = await seedDcrServerWithClient(dcrBody);
      const otherUserRef = 'user:someone-else';
      for (const userRef of [STANDALONE_REQUEST_CONTEXT.subject.id, otherUserRef]) {
        await tokenStore.saveToken({
          id: record.id,
          userRef,
          token: {
            accessToken: `access-${userRef}`,
            refreshToken: `refresh-${userRef}`,
            expiresAt: '2099-01-01T00:00:00.000Z',
            scope: null,
          },
        });
      }

      const response = await settingsRouter.request(`/${dcrBody.name}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      // The connector row is shared, so deletion must not leave another user's
      // credentials behind under the deleted server id.
      expect(
        await tokenStore.getToken({ id: record.id, userRef: STANDALONE_REQUEST_CONTEXT.subject.id }),
      ).toBeUndefined();
      expect(await tokenStore.getToken({ id: record.id, userRef: otherUserRef })).toBeUndefined();

      const get = await settingsRouter.request(`/${dcrBody.name}`);
      expect(get.status).toBe(404);
    });

    it('deleting the flagged memory provider leaves no provider configured', async () => {
      // Neutralize whichever connector still holds the flag from the suite above, so creating
      // this test's own flagged connector does not 409.
      const existing = await mcpServerStore.listServers({ tenant_id: TENANT_ID, names: undefined });
      const holder = existing.find(
        server => server.manifest.type === 'remote' && server.manifest.memory_provider === true,
      );
      if (holder !== undefined && holder.manifest.type === 'remote') {
        const { memory_provider: _flag, ...withoutFlag } = holder.manifest;
        await settingsRouter.request('/', putInit(wrapManifest(withoutFlag)));
      }

      const memoryProviderBody = {
        type: 'remote' as const,
        name: 'delete-target-memory-provider-mcp',
        url: 'https://hindsight.example.com/mcp/aman/',
        description: 'Memory provider created only to be deleted.',
        memory_provider: true,
      };
      const put = await settingsRouter.request('/', putInit(wrapManifest(memoryProviderBody)));
      expect(put.status).toBe(200);

      const response = await settingsRouter.request(`/${memoryProviderBody.name}`, { method: 'DELETE' });
      expect(response.status).toBe(200);

      const list = await settingsRouter.request('/');
      const listBody = (await list.json()) as { data: { name: string }[] };
      expect(listBody.data.find(server => server.name === memoryProviderBody.name)).toBeUndefined();
    });
  });

  describe('Always allow tool grants', () => {
    const OTHER_USER = 'user:someone-else';
    const notesBody = {
      type: 'remote' as const,
      name: 'grant-notes-mcp',
      url: 'https://notes.example.com/mcp',
      description: 'Notes connector used by the grant tests.',
    };

    function grantFor(input: { created_by: string; tool_name: string }) {
      return { tenant_id: TENANT_ID, mcp_server_name: notesBody.name, ...input };
    }

    async function listedGrants(): Promise<string[]> {
      const response = await mcpServersRouter.request(`/${notesBody.name}/tool-grants`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { tool_name: string; created_at: string }[] };
      return body.data.map(grant => grant.tool_name);
    }

    beforeEach(async () => {
      const put = await settingsRouter.request('/', putInit(wrapManifest(notesBody)));
      expect(put.status).toBe(200);
      await toolGrantStore.recordToolGrant(
        grantFor({ created_by: STANDALONE_REQUEST_CONTEXT.subject.id, tool_name: 'lookup_note' }),
      );
      await toolGrantStore.recordToolGrant(grantFor({ created_by: OTHER_USER, tool_name: 'lookup_note' }));
    });

    afterEach(async () => {
      await settingsRouter.request(`/${notesBody.name}`, { method: 'DELETE' });
    });

    it("lists only the caller's grants", async () => {
      await toolGrantStore.recordToolGrant(grantFor({ created_by: OTHER_USER, tool_name: 'list_notes' }));
      expect(await listedGrants()).toEqual(['lookup_note']);
    });

    it("revokes one of the caller's grants and leaves other users' grants alone", async () => {
      const response = await mcpServersRouter.request(`/${notesBody.name}/tool-grants/lookup_note`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      expect(await listedGrants()).toEqual([]);
      expect(await toolGrantStore.hasToolGrant(grantFor({ created_by: OTHER_USER, tool_name: 'lookup_note' }))).toBe(
        true,
      );
    });

    it('404s for an unknown connector', async () => {
      const list = await mcpServersRouter.request('/missing-grant-mcp/tool-grants');
      expect(list.status).toBe(404);
      const revoke = await mcpServersRouter.request('/missing-grant-mcp/tool-grants/lookup_note', { method: 'DELETE' });
      expect(revoke.status).toBe(404);
    });

    it('drops the grants of every user when the connector URL changes, but not on an unrelated edit', async () => {
      const described = await settingsRouter.request(
        '/',
        putInit(wrapManifest({ ...notesBody, description: 'Same server, new words.' })),
      );
      expect(described.status).toBe(200);
      expect(await listedGrants()).toEqual(['lookup_note']);

      const moved = await settingsRouter.request(
        '/',
        putInit(wrapManifest({ ...notesBody, url: 'https://elsewhere.example.com/mcp' })),
      );
      expect(moved.status).toBe(200);
      expect(await listedGrants()).toEqual([]);
      expect(await toolGrantStore.hasToolGrant(grantFor({ created_by: OTHER_USER, tool_name: 'lookup_note' }))).toBe(
        false,
      );
    });

    it('drops the grants of every user when the connector is deleted', async () => {
      const response = await settingsRouter.request(`/${notesBody.name}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      for (const created_by of [STANDALONE_REQUEST_CONTEXT.subject.id, OTHER_USER]) {
        expect(await toolGrantStore.hasToolGrant(grantFor({ created_by, tool_name: 'lookup_note' }))).toBe(false);
      }
    });
  });
});
