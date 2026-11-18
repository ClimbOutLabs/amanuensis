import { RemoteMCP } from '@truefoundry/trueforge-core/core';
import { mcpOutboundBaseFetch } from '@truefoundry/trueforge-core/core/util/outboundFetch';
import { createLogger } from 'winston';
import { McpServerWithAuthStore } from '../../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { completeMcpAuthorization } from '../../../../src/mcp/auth/mcpDcr';
import { mcpOAuthCallbackUrl } from '../../../../src/mcp/auth/mcpOAuthHelpers';
import { getMcpConnection } from '../../../../src/runtime/sessionResources';

jest.mock('@truefoundry/trueforge-core/core/util/outboundFetch', () => {
  const actual = jest.requireActual<typeof import('@truefoundry/trueforge-core/core/util/outboundFetch')>(
    '@truefoundry/trueforge-core/core/util/outboundFetch',
  );
  return { ...actual, mcpOutboundBaseFetch: jest.fn() };
});
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  networkInterfaces: () => ({}),
}));
jest.mock('node:dns/promises', () => ({
  ...jest.requireActual<typeof import('node:dns/promises')>('node:dns/promises'),
  lookup: async (_hostname: string, options?: { all?: boolean }) => {
    const entry = { address: '93.184.216.34', family: 4 };
    return options?.all ? [entry] : entry;
  },
}));

const resource = 'https://mcp.example.com/mcp';
const metadataUrl = 'https://mcp.example.com/custom-metadata';
const issuer = 'https://auth.example.com/tenant';
const originalFetch = globalThis.fetch;
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.clearAllMocks();
});

test('a Bearer challenge leads to consent, callback, and an authenticated MCP initialization', async () => {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const tokenStore = new SqliteOAuthTokenStore(db);
  const rawStore = new SqliteMcpServerStore(db);
  const store = new McpServerWithAuthStore({ store: rawStore, tokenStore, clientName: 'Test' });
  await store.createServer({
    tenant_id: 'tenant',
    name: 'flights',
    first_party: false,
    manifest: { type: 'remote', name: 'flights', url: resource, description: 'Flights' },
  });
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === metadataUrl) return json({ resource, authorization_servers: [issuer] });
    if (url.includes('oauth-authorization-server'))
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        revocation_endpoint: `${issuer}/revoke`,
        revocation_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url === `${issuer}/register`)
      return json({
        client_id: 'public-client',
        token_endpoint_auth_method: 'none',
        redirect_uris: [mcpOAuthCallbackUrl()],
      });
    if (url === `${issuer}/revoke`) {
      expect(new URLSearchParams(String(init?.body)).get('token')).toBe('private-access-token');
      return new Response(null, { status: 200 });
    }
    if (url === `${issuer}/token`) {
      expect(String(init?.body)).toContain('resource=https%3A%2F%2Fmcp.example.com%2Fmcp');
      return json({ access_token: 'private-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response(null, { status: 404 });
  };
  const mcpCalls: string[] = [];
  jest.mocked(mcpOutboundBaseFetch).mockImplementation(async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    mcpCalls.push(authorization);
    if (authorization !== 'Bearer private-access-token')
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}", scope="flights:search"` },
      });
    const request: unknown = JSON.parse(String(init?.body));
    if (typeof request !== 'object' || request === null || !('method' in request)) throw new Error('invalid request');
    const method = Reflect.get(request, 'method');
    const id = Reflect.get(request, 'id');
    if (method === 'initialize')
      return json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        },
      });
    if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: [] } });
    return new Response(null, { status: 202 });
  });
  const connection = await getMcpConnection({
    tenant_id: 'tenant',
    name: 'flights',
    store,
    tokenStore,
    clientName: 'Test',
    userRef: 'alice',
  });
  if (!connection) throw new Error('missing connector');
  const remote = new RemoteMCP({
    id: 'flights',
    name: 'flights',
    url: resource,
    headers: connection.headers,
    logger: createLogger({ silent: true }),
    requestTimeoutMs: 5000,
    connectTimeoutMs: 5000,
    signal: new AbortController().signal,
  });
  const first = await remote.listTools();
  if (!('authRequired' in first)) throw new Error('expected sign-in');
  const url = new URL(first.authRequired.servers[0]?.auth_url ?? '');
  expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('resource')).toBe(resource);
  expect(url.searchParams.get('scope')).toBe('flights:search');
  expect(calls[0]).toBe(metadataUrl);
  const pending = await tokenStore.consumePendingAuthorization({ state: url.searchParams.get('state') ?? '' });
  if (!pending) throw new Error('missing pending grant');
  await completeMcpAuthorization({ tokenStore, mcpServerStore: store, pending, code: 'test-code' });
  const result = await remote.listTools();
  expect('result' in result && result.result.tools).toEqual([]);
  expect(mcpCalls).toContain('Bearer private-access-token');
  await store.deleteAuthorization({ tenant_id: 'tenant', name: 'flights', userRef: 'alice' });
  expect(calls).toContain(`${issuer}/revoke`);
  expect(await tokenStore.getToken({ id: pending.id, userRef: 'alice' })).toBeUndefined();
  await db.destroy();
});
