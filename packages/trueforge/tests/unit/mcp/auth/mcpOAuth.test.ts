/**
 * MCP OAuth / DCR helper tests (node:test style via jest).
 * Global fetch is stubbed; production code uses real fetch only.
 */
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { InMemoryOAuthClientStore, InMemoryOAuthTokenStore } from '../../../../src/mcp/auth/inMemoryStores';
import {
  McpOAuthAddressRefusedError,
  buildMcpAuthorizationUrl,
  completeMcpAuthorization,
  createMcpOAuthClient,
  dialMcpOAuthUrl,
  ensureMcpClientRegistered,
  isMcpAuthRequired,
  resolveMcpAuth,
} from '../../../../src/mcp/auth/mcpDcr';
import { DEFAULT_MCP_ACCESS_TOKEN_TTL_SECONDS, mcpOAuthCallbackUrl } from '../../../../src/mcp/auth/mcpOAuthHelpers';
import type { OAuthClientRecord } from '../../../../src/mcp/auth/types';

// Name resolution is stubbed for the whole suite: the two example hosts resolve to a public
// address, blocked.example.com resolves to loopback, and every other name does not resolve.
// The sign-in dials are judged by the address check, so the suite's answer cannot depend on
// the DNS of the machine running it, and no real lookup leaves the suite.
jest.mock('node:dns/promises', () => {
  const actual = jest.requireActual<typeof import('node:dns/promises')>('node:dns/promises');
  return {
    ...actual,
    lookup: async (hostname: string, options?: { all?: boolean | undefined }) => {
      const address =
        hostname === 'mcp.example.com' || hostname === 'auth.example.com'
          ? '93.184.216.34'
          : hostname === 'blocked.example.com' || hostname === 'localhost'
            ? '127.0.0.1'
            : undefined;
      if (address === undefined) {
        const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        Reflect.set(error, 'code', 'ENOTFOUND');
        throw error;
      }
      const entry = { address, family: 4 };
      return options?.all === true ? [entry] : entry;
    },
  };
});

interface Stores {
  tokenStore: InMemoryOAuthTokenStore;
  mcpServerStore: InMemoryOAuthClientStore;
}

/** Token store + MCP-server OAuth-client facet, freshly backed in memory per test. */
function newStores(): Stores {
  return { tokenStore: new InMemoryOAuthTokenStore(), mcpServerStore: new InMemoryOAuthClientStore() };
}

const CLIENT_NAME = 'harness';
const SERVER_URL = 'https://mcp.example.com/sse';
const AS_ORIGIN = 'https://auth.example.com';
const SERVER_ID = 'mcp-server-id-1';
const SERVER_NAME = 'svc';
const USER_REF = 'user-a';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AS_METADATA = {
  issuer: AS_ORIGIN,
  authorization_endpoint: `${AS_ORIGIN}/authorize`,
  token_endpoint: `${AS_ORIGIN}/token`,
  registration_endpoint: `${AS_ORIGIN}/register`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
};

function stubOauthFetch(options: {
  registrationFailFirst?: boolean;
  registrationFailAlways?: boolean;
  /** Non-OAuth registration failure (e.g. 500) — must not trigger auth-method fallback. */
  registrationHttpError?: { status: number; body?: string };
  skipRegistrationEndpoint?: boolean;
  codeChallengeMethodsSupported?: string[] | null;
  registeredClient?: { client_id: string; client_secret?: string; token_endpoint_auth_method?: string };
  tokenResponse?: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string };
  tokenFail?: boolean;
}): {
  registerBodies: unknown[];
  registerCallCount: () => number;
  tokenBodies: unknown[];
  tokenAuthHeaders: string[];
} {
  let registerCalls = 0;
  const registerBodies: unknown[] = [];
  const tokenBodies: unknown[] = [];
  const tokenAuthHeaders: string[] = [];
  const registered = options.registeredClient ?? {
    client_id: 'dyn-client-1',
    client_secret: 'dyn-secret-1',
    token_endpoint_auth_method: 'client_secret_post',
  };

  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    if (url.includes('oauth-protected-resource')) {
      return json({ resource: SERVER_URL, authorization_servers: [AS_ORIGIN] });
    }

    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
      const metadata: Record<string, unknown> = { ...AS_METADATA };
      if (options.skipRegistrationEndpoint) {
        delete metadata['registration_endpoint'];
      }
      if (options.codeChallengeMethodsSupported === null) {
        delete metadata['code_challenge_methods_supported'];
      } else if (options.codeChallengeMethodsSupported !== undefined) {
        metadata['code_challenge_methods_supported'] = options.codeChallengeMethodsSupported;
      }
      return json(metadata);
    }

    if (url === `${AS_ORIGIN}/register` && init?.method === 'POST') {
      registerCalls += 1;
      registerBodies.push(JSON.parse(String(init.body)));
      if (options.registrationHttpError) {
        return new Response(options.registrationHttpError.body ?? 'server error', {
          status: options.registrationHttpError.status,
        });
      }
      if (options.registrationFailAlways || (options.registrationFailFirst && registerCalls === 1)) {
        return json({ error: 'invalid_client_metadata' }, 400);
      }
      return json({
        ...registered,
        redirect_uris: [mcpOAuthCallbackUrl()],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }

    if (url === `${AS_ORIGIN}/token` && init?.method === 'POST') {
      tokenBodies.push(String(init.body));
      const headers = new Headers(init.headers);
      tokenAuthHeaders.push(headers.get('Authorization') ?? '');
      if (options.tokenFail) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const tokens = options.tokenResponse ?? {
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      return json({ token_type: 'Bearer', ...tokens });
    }

    return new Response(`unexpected url: ${url}`, { status: 404 });
  }) as typeof fetch;

  return { registerBodies, registerCallCount: () => registerCalls, tokenBodies, tokenAuthHeaders };
}

const sampleClient: OAuthClientRecord = {
  server: {
    authorizationEndpoint: `${AS_ORIGIN}/authorize`,
    tokenEndpoint: `${AS_ORIGIN}/token`,
    codeChallengeMethodsSupported: ['S256'],
  },
  client: {
    clientId: 'cached-client',
    clientSecret: 'cached-secret',
  },
};

describe('resourceUrlFromServerUrl (SDK)', () => {
  it('strips fragment (RFC 8707 resource indicator)', () => {
    const resource = resourceUrlFromServerUrl('https://mcp.example.com/sse#frag');
    expect(resource.hash).toBe('');
    expect(resource.pathname).toBe('/sse');
  });
});

describe('createMcpOAuthClient / ensureMcpClientRegistered', () => {
  it('returns the cached client without discovery or registration', async () => {
    const { mcpServerStore } = newStores();
    await mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    const { registerCallCount } = stubOauthFetch({});

    const result = await ensureMcpClientRegistered({
      mcpServerStore,
      serverId: SERVER_ID,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      clientName: CLIENT_NAME,
      authType: 'dcr',
    });

    expect(result).toEqual(sampleClient);
    expect(registerCallCount()).toBe(0);
  });

  it('oauth_client: discovers metadata and builds client from manifest without registration', async () => {
    const { mcpServerStore } = newStores();
    stubOauthFetch({});

    const result = await ensureMcpClientRegistered({
      mcpServerStore,
      serverId: SERVER_ID,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      clientName: CLIENT_NAME,
      authType: 'oauth_client',
      oauthClientId: 'manifest-client-id',
      oauthClientSecret: 'manifest-client-secret',
    });

    expect(result.client.clientId).toBe('manifest-client-id');
    expect(result.client.clientSecret).toBe('manifest-client-secret');
    expect(result.server.authorizationEndpoint).toBe(`${AS_ORIGIN}/authorize`);
    expect(result.server.tokenEndpoint).toBe(`${AS_ORIGIN}/token`);
    const stored = await mcpServerStore.getClient({ id: SERVER_ID });
    expect(stored).toBeUndefined();
  });

  it('oauth_client: throws when credentials are missing', async () => {
    const { mcpServerStore } = newStores();
    stubOauthFetch({});

    await expect(
      ensureMcpClientRegistered({
        mcpServerStore,
        serverId: SERVER_ID,
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        clientName: CLIENT_NAME,
        authType: 'oauth_client',
      }),
    ).rejects.toMatchObject({
      name: 'McpConnectionError',
      message: expect.stringContaining('OAuth client auth requires client_id and client_secret'),
    });
  });

  it('discovers, registers confidential client, and saves the record', async () => {
    const { mcpServerStore } = newStores();
    const { registerBodies } = stubOauthFetch({});

    const result = await ensureMcpClientRegistered({
      mcpServerStore,
      serverId: SERVER_ID,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      clientName: CLIENT_NAME,
      authType: 'dcr',
    });

    expect(result.client.clientId).toBe('dyn-client-1');
    expect(result.client.clientSecret).toBe('dyn-secret-1');
    expect(result.server.authorizationEndpoint).toBe(`${AS_ORIGIN}/authorize`);
    expect(result.server.tokenEndpoint).toBe(`${AS_ORIGIN}/token`);
    expect(result.server.codeChallengeMethodsSupported).toEqual(['S256']);
    expect(registerBodies).toHaveLength(1);
    const body = registerBodies[0] as Record<string, unknown>;
    expect(body['token_endpoint_auth_method']).toBe('client_secret_post');
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect(body['client_name']).toBe(CLIENT_NAME);
    expect(body['redirect_uris']).toEqual([mcpOAuthCallbackUrl()]);
  });

  it('retries registration without token_endpoint_auth_method on invalid_client_metadata', async () => {
    const { mcpServerStore } = newStores();
    const { registerBodies, registerCallCount } = stubOauthFetch({
      registrationFailFirst: true,
      registeredClient: { client_id: 'public-client' },
    });

    const result = await ensureMcpClientRegistered({
      mcpServerStore,
      serverId: SERVER_ID,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      clientName: CLIENT_NAME,
      authType: 'dcr',
    });

    expect(result.client.clientId).toBe('public-client');
    expect(result.client.clientSecret).toBeNull();
    expect(registerCallCount()).toBe(2);
    expect((registerBodies[0] as Record<string, unknown>)['token_endpoint_auth_method']).toBe('client_secret_post');
    expect((registerBodies[1] as Record<string, unknown>)['token_endpoint_auth_method']).toBeUndefined();
  });

  it('rejects registration responses without client_id as failed dependencies', async () => {
    stubOauthFetch({ registeredClient: { client_id: '' } });

    await expect(
      createMcpOAuthClient({
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        redirectUris: [mcpOAuthCallbackUrl()],
        clientName: CLIENT_NAME,
      }),
    ).rejects.toMatchObject({ name: 'McpConnectionError', statusCode: 424 });
  });

  it('does not retry registration on non-metadata failures', async () => {
    const { mcpServerStore } = newStores();
    const { registerCallCount } = stubOauthFetch({
      registrationHttpError: { status: 500, body: 'boom' },
    });

    await expect(
      ensureMcpClientRegistered({
        mcpServerStore,
        serverId: SERVER_ID,
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        clientName: CLIENT_NAME,
        authType: 'dcr',
      }),
    ).rejects.toMatchObject({ name: 'McpConnectionError', statusCode: 424 });
    expect(registerCallCount()).toBe(1);
  });

  it('throws when the AS has no registration_endpoint', async () => {
    const { mcpServerStore } = newStores();
    stubOauthFetch({ skipRegistrationEndpoint: true });

    await expect(
      ensureMcpClientRegistered({
        mcpServerStore,
        serverId: SERVER_ID,
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        clientName: CLIENT_NAME,
        authType: 'dcr',
      }),
    ).rejects.toMatchObject({
      name: 'McpDcrConfigurationError',
      message: expect.stringContaining('no DCR support'),
    });
  });

  it('does not save a client when both registration attempts fail', async () => {
    const { mcpServerStore } = newStores();
    const { registerCallCount } = stubOauthFetch({ registrationFailAlways: true });

    await expect(
      createMcpOAuthClient({
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        redirectUris: [mcpOAuthCallbackUrl()],
        clientName: CLIENT_NAME,
      }),
    ).rejects.toMatchObject({ name: 'McpConnectionError', statusCode: 424 });
    expect(registerCallCount()).toBe(2);
    expect(await mcpServerStore.getClient({ id: SERVER_ID })).toBeUndefined();
  });
});

describe('buildMcpAuthorizationUrl', () => {
  it('saves pending authorization with PKCE when the AS advertises S256', async () => {
    const { tokenStore } = newStores();
    stubOauthFetch({});

    const { authorizationUrl: authUrl, state } = await buildMcpAuthorizationUrl({
      tokenStore,
      client: sampleClient,
      serverId: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      returnTo: '/after',
    });

    expect(authUrl).toBeInstanceOf(URL);
    expect(authUrl.origin + authUrl.pathname).toBe(`${AS_ORIGIN}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe(sampleClient.client.clientId);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(mcpOAuthCallbackUrl());
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('resource')).toBe(resourceUrlFromServerUrl(SERVER_URL).href);

    expect(state).toBeTruthy();
    expect(authUrl.searchParams.get('state')).toBe(state);
    const pending = await tokenStore.consumePendingAuthorization({ state });
    expect(pending).toMatchObject({
      state,
      id: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      returnTo: '/after',
    });
    expect(pending?.codeVerifier).toBeTruthy();
  });

  it('still uses PKCE S256 when the AS does not advertise code_challenge_methods', async () => {
    const { tokenStore } = newStores();
    const client: OAuthClientRecord = {
      ...sampleClient,
      server: { ...sampleClient.server, codeChallengeMethodsSupported: null },
    };

    const { authorizationUrl: authUrl } = await buildMcpAuthorizationUrl({
      tokenStore,
      client,
      serverId: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
    });

    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('rejects at registration when the AS advertises PKCE methods without S256', async () => {
    stubOauthFetch({ codeChallengeMethodsSupported: ['plain'] });

    await expect(
      createMcpOAuthClient({
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
        redirectUris: [mcpOAuthCallbackUrl()],
        clientName: CLIENT_NAME,
      }),
    ).rejects.toMatchObject({
      name: 'McpDcrConfigurationError',
      message: expect.stringContaining('without S256'),
    });
  });

  it('throws when stored client metadata lists only non-S256 methods', async () => {
    const { tokenStore } = newStores();
    const client: OAuthClientRecord = {
      ...sampleClient,
      server: { ...sampleClient.server, codeChallengeMethodsSupported: ['plain'] },
    };

    await expect(
      buildMcpAuthorizationUrl({
        tokenStore,
        client,
        serverId: SERVER_ID,
        userRef: USER_REF,
        mcpServerUrl: SERVER_URL,
        mcpServerName: SERVER_NAME,
      }),
    ).rejects.toMatchObject({
      name: 'McpConnectionError',
      message: expect.stringContaining('Failed to start OAuth authorization'),
      statusCode: 424,
    });
  });
});

const resolveParams = (
  stores: Stores,
  mcpServerUrl = SERVER_URL,
  authType: 'dcr' | 'oauth_client' = 'dcr',
  oauthClientId?: string,
  oauthClientSecret?: string,
) => ({
  tokenStore: stores.tokenStore,
  mcpServerStore: stores.mcpServerStore,
  serverId: SERVER_ID,
  userRef: USER_REF,
  mcpServerUrl,
  mcpServerName: SERVER_NAME,
  clientName: CLIENT_NAME,
  authType,
  ...(oauthClientId !== undefined ? { oauthClientId } : {}),
  ...(oauthClientSecret !== undefined ? { oauthClientSecret } : {}),
});

describe('resolveMcpAuth', () => {
  it('returns bearer headers when the token is still valid', async () => {
    const stores = newStores();
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: USER_REF,
      token: {
        accessToken: 'live-token',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        scope: null,
      },
    });

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(result).toEqual({ headers: { Authorization: 'Bearer live-token' } });
  });

  it("does not reuse another user's token for the same server", async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: 'other-user',
      token: {
        accessToken: 'other-user-token',
        refreshToken: null,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        scope: null,
      },
    });
    stubOauthFetch({});

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(isMcpAuthRequired(result)).toBe(true);
    expect(await stores.tokenStore.getToken({ id: SERVER_ID, userRef: 'other-user' })).toMatchObject({
      accessToken: 'other-user-token',
    });
  });

  it('refreshes an expired token when a refresh_token is stored', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: USER_REF,
      token: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scope: null,
      },
    });
    const { tokenBodies, tokenAuthHeaders } = stubOauthFetch({
      tokenResponse: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    });

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(result).toEqual({ headers: { Authorization: 'Bearer new-access' } });
    expect(tokenBodies).toHaveLength(1);
    expect(String(tokenBodies[0])).toContain('grant_type=refresh_token');
    // Secret present → client_secret_post (form body), not HTTP Basic.
    expect(String(tokenBodies[0])).toContain('client_secret=cached-secret');
    expect(tokenAuthHeaders[0]).toBe('');
    const saved = await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF });
    expect(saved?.accessToken).toBe('new-access');
    expect(saved?.refreshToken).toBe('new-refresh');
  });

  it('uses a default TTL when the token response omits expires_in', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: USER_REF,
      token: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scope: null,
      },
    });
    stubOauthFetch({
      tokenResponse: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
      },
    });

    const beforeMs = Date.now();
    const result = await resolveMcpAuth(resolveParams(stores));
    const afterMs = Date.now();

    expect(result).toEqual({ headers: { Authorization: 'Bearer new-access' } });
    const saved = await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF });
    const expiresAtMs = Date.parse(saved!.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeMs + DEFAULT_MCP_ACCESS_TOKEN_TTL_SECONDS * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(afterMs + DEFAULT_MCP_ACCESS_TOKEN_TTL_SECONDS * 1000);
    // Still usable on the next resolve.
    const again = await resolveMcpAuth(resolveParams(stores));
    expect(again).toEqual({ headers: { Authorization: 'Bearer new-access' } });
  });

  it('returns authentication_required and clears token when refresh fails', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: USER_REF,
      token: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scope: null,
      },
    });
    stubOauthFetch({ tokenFail: true });

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(isMcpAuthRequired(result)).toBe(true);
    if (!isMcpAuthRequired(result)) throw new Error('unreachable');
    expect(result.authUrl).toBeInstanceOf(URL);
    expect(await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF })).toBeUndefined();
    expect(await stores.mcpServerStore.getClient({ id: SERVER_ID })).toEqual(sampleClient);
  });

  it('returns authentication_required and clears expired token without refresh_token', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    await stores.tokenStore.saveToken({
      id: SERVER_ID,
      userRef: USER_REF,
      token: {
        accessToken: 'old-access',
        refreshToken: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        scope: null,
      },
    });
    stubOauthFetch({});

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(isMcpAuthRequired(result)).toBe(true);
    if (!isMcpAuthRequired(result)) throw new Error('unreachable');
    expect(result.authUrl).toBeInstanceOf(URL);
    expect(result.authUrl.href).toContain('/authorize');
    expect(await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF })).toBeUndefined();
    expect(await stores.mcpServerStore.getClient({ id: SERVER_ID })).toEqual(sampleClient);
  });

  it('returns authentication_required when no token exists', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    stubOauthFetch({});

    const result = await resolveMcpAuth(resolveParams(stores));

    expect(isMcpAuthRequired(result)).toBe(true);
    if (!isMcpAuthRequired(result)) throw new Error('unreachable');
    expect(result.authUrl.searchParams.get('state')).toBeTruthy();
  });
});

describe('end-to-end DCR + authorize with normalised MCP URL', () => {
  it('registers, builds auth URL with resource, and resolves auth_required without a token', async () => {
    // Mixed-case scheme/host + fragment: resource indicator must still be RFC-8707-safe.
    const mixedUrl = 'HTTPS://MCP.Example.COM/sse#fragment';
    const stores = newStores();
    const { registerBodies } = stubOauthFetch({});

    const result = await resolveMcpAuth(resolveParams(stores, mixedUrl));

    expect(isMcpAuthRequired(result)).toBe(true);
    if (!isMcpAuthRequired(result)) throw new Error('unreachable');

    expect(registerBodies).toHaveLength(1);
    const client = await stores.mcpServerStore.getClient({ id: SERVER_ID });
    expect(client?.client.clientId).toBe('dyn-client-1');

    const url = result.authUrl;
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Fragment stripped; resource is absolute URL for this MCP server.
    expect(url.searchParams.get('resource')).toBe(resourceUrlFromServerUrl(mixedUrl).href);
    expect(url.searchParams.get('resource')).not.toContain('#');
  });
});

describe('completeMcpAuthorization', () => {
  it('exchanges the code and saves the token for the claimed pending row', async () => {
    const stores = newStores();
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });

    const { authorizationUrl: authUrl, state } = await buildMcpAuthorizationUrl({
      tokenStore: stores.tokenStore,
      client: sampleClient,
      serverId: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      returnTo: '/connected',
    });
    expect(authUrl.searchParams.get('state')).toBe(state);

    const { tokenBodies } = stubOauthFetch({
      tokenResponse: {
        access_token: 'exchanged-access',
        refresh_token: 'exchanged-refresh',
        expires_in: 1800,
        token_type: 'Bearer',
      },
    });

    const pending = await stores.tokenStore.consumePendingAuthorization({ state });
    if (!pending) {
      throw new Error('expected buildMcpAuthorizationUrl to save a pending authorization');
    }
    expect(pending.returnTo).toBe('/connected');

    const beforeMs = Date.now();
    await completeMcpAuthorization({
      tokenStore: stores.tokenStore,
      mcpServerStore: stores.mcpServerStore,
      pending,
      code: 'auth-code-1',
    });
    const afterMs = Date.now();

    // The row was claimed once; a duplicate callback finds nothing left to redeem.
    expect(await stores.tokenStore.consumePendingAuthorization({ state })).toBeUndefined();
    const saved = await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF });
    expect(saved?.accessToken).toBe('exchanged-access');
    expect(saved?.refreshToken).toBe('exchanged-refresh');
    const expiresAtMs = Date.parse(saved!.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeMs + 1800 * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(afterMs + 1800 * 1000);
    expect(tokenBodies).toHaveLength(1);
    const tokenBody = new URLSearchParams(String(tokenBodies[0]));
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code')).toBe('auth-code-1');
    expect(tokenBody.get('code_verifier')).toBeTruthy();
    expect(tokenBody.get('resource')).toBe(resourceUrlFromServerUrl(SERVER_URL).href);
  });

  it('throws when the pending row has no registered OAuth client', async () => {
    const stores = newStores();
    await expect(
      completeMcpAuthorization({
        tokenStore: stores.tokenStore,
        mcpServerStore: stores.mcpServerStore,
        pending: {
          state: 'state-1',
          id: SERVER_ID,
          userRef: USER_REF,
          mcpServerUrl: SERVER_URL,
          codeVerifier: 'verifier-1',
          returnTo: null,
        },
        code: 'code',
      }),
    ).rejects.toMatchObject({
      name: 'McpConnectionError',
      message: expect.stringContaining('No OAuth client registered'),
    });
  });

  it('clears client state on invalid_client and surfaces a re-connect error', async () => {
    const stores = newStores();
    const deleteClient = jest.spyOn(stores.mcpServerStore, 'deleteClient');
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: sampleClient });
    const { state } = await buildMcpAuthorizationUrl({
      tokenStore: stores.tokenStore,
      client: sampleClient,
      serverId: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      returnTo: '/after',
    });

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === `${AS_ORIGIN}/token` && init?.method === 'POST') {
        return json({ error: 'invalid_client', error_description: 'client gone' }, 401);
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    }) as typeof fetch;

    const pending = await stores.tokenStore.consumePendingAuthorization({ state });
    if (!pending) {
      throw new Error('expected buildMcpAuthorizationUrl to save a pending authorization');
    }

    await expect(
      completeMcpAuthorization({
        tokenStore: stores.tokenStore,
        mcpServerStore: stores.mcpServerStore,
        pending,
        code: 'auth-code-1',
      }),
    ).rejects.toMatchObject({
      name: 'McpConnectionError',
      message: expect.stringContaining('registration is invalid'),
    });
    expect(deleteClient).toHaveBeenCalledWith({ id: SERVER_ID });
    expect(await stores.mcpServerStore.getClient({ id: SERVER_ID })).toBeUndefined();
  });

  it('oauth_client: builds authorization URL without registering', async () => {
    const stores = newStores();
    stubOauthFetch({});

    const result = await resolveMcpAuth(
      resolveParams(stores, SERVER_URL, 'oauth_client', 'manifest-client-id', 'manifest-client-secret'),
    );

    expect(isMcpAuthRequired(result)).toBe(true);
    if (isMcpAuthRequired(result)) {
      expect(result.authUrl.searchParams.has('client_id')).toBe(true);
      expect(result.authUrl.searchParams.get('client_id')).toBe('manifest-client-id');
    }
  });

  it('oauth_client: token exchange uses configured client credentials', async () => {
    const stores = newStores();
    const oauthClientRecord: OAuthClientRecord = {
      server: {
        authorizationEndpoint: `${AS_ORIGIN}/authorize`,
        tokenEndpoint: `${AS_ORIGIN}/token`,
        codeChallengeMethodsSupported: ['S256'],
      },
      client: {
        clientId: 'manifest-client-id',
        clientSecret: 'manifest-client-secret',
      },
    };
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: oauthClientRecord });
    const { tokenBodies } = stubOauthFetch({});

    await stores.tokenStore.savePendingAuthorization({
      state: 'test-state',
      id: SERVER_ID,
      userRef: USER_REF,
      mcpServerUrl: SERVER_URL,
      codeVerifier: 'test-verifier-123456789012345678901234567890',
      returnTo: null,
    });

    const pending = await stores.tokenStore.consumePendingAuthorization({ state: 'test-state' });
    if (!pending) {
      throw new Error('expected consumePendingAuthorization to return pending');
    }

    await completeMcpAuthorization({
      tokenStore: stores.tokenStore,
      mcpServerStore: stores.mcpServerStore,
      pending,
      code: 'test-code',
    });

    expect(tokenBodies.length).toBeGreaterThan(0);
    const savedToken = await stores.tokenStore.getToken({ id: SERVER_ID, userRef: USER_REF });
    expect(savedToken).toBeDefined();
  });
});

describe('the address check on sign-in dials', () => {
  /** A transport that records every URL it was asked to dial and serves the OAuth flow. */
  function stubRecordingFetch(options: { registrationEndpoint?: string; redirectMetadataTo?: string }): {
    dialed: string[];
  } {
    const dialed: string[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      dialed.push(url);
      if (url.includes('oauth-protected-resource')) {
        return json({ resource: SERVER_URL, authorization_servers: [AS_ORIGIN] });
      }
      if (url === `${AS_ORIGIN}/.well-known/oauth-authorization-server` && options.redirectMetadataTo !== undefined) {
        return new Response(null, { status: 302, headers: { location: options.redirectMetadataTo } });
      }
      if (
        url.includes('oauth-authorization-server') ||
        url.includes('openid-configuration') ||
        url === `${AS_ORIGIN}/as-metadata`
      ) {
        const metadata: Record<string, unknown> = { ...AS_METADATA };
        if (options.registrationEndpoint !== undefined) {
          metadata['registration_endpoint'] = options.registrationEndpoint;
        }
        return json(metadata);
      }
      if (url.endsWith('/register') && init?.method === 'POST') {
        return json({
          client_id: 'dyn-client-1',
          client_secret: 'dyn-secret-1',
          token_endpoint_auth_method: 'client_secret_post',
          redirect_uris: [mcpOAuthCallbackUrl()],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        });
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    };
    return { dialed };
  }

  it('refuses to dial a registration endpoint that resolves to a refused address', async () => {
    const { dialed } = stubRecordingFetch({ registrationEndpoint: 'https://blocked.example.com/register' });

    const attempt = createMcpOAuthClient({
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      redirectUris: [mcpOAuthCallbackUrl()],
      clientName: CLIENT_NAME,
    });
    await expect(attempt).rejects.toBeInstanceOf(McpOAuthAddressRefusedError);
    await expect(attempt).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('may not connect to'),
    });
    expect(dialed.some(url => url.includes('blocked.example.com'))).toBe(false);
  });

  it('refuses a sign-in redirect to a refused address, and never dials it', async () => {
    const { dialed } = stubRecordingFetch({
      redirectMetadataTo: 'https://blocked.example.com/.well-known/oauth-authorization-server',
    });

    const attempt = createMcpOAuthClient({
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      redirectUris: [mcpOAuthCallbackUrl()],
      clientName: CLIENT_NAME,
    });
    await expect(attempt).rejects.toBeInstanceOf(McpOAuthAddressRefusedError);
    expect(dialed.some(url => url.includes('blocked.example.com'))).toBe(false);
  });

  it('follows a sign-in redirect the check passes', async () => {
    stubRecordingFetch({ redirectMetadataTo: `${AS_ORIGIN}/as-metadata` });

    const client = await createMcpOAuthClient({
      mcpServerUrl: SERVER_URL,
      mcpServerName: SERVER_NAME,
      redirectUris: [mcpOAuthCallbackUrl()],
      clientName: CLIENT_NAME,
    });
    expect(client.client.clientId).toBe('dyn-client-1');
  });

  it('drops the credential headers when a sign-in redirect crosses origins, and keeps them within the origin', async () => {
    const received: Array<{ url: string; headers: Headers }> = [];
    const stubDial = (redirectTarget: string): void => {
      received.length = 0;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        received.push({ url, headers: new Headers(init?.headers) });
        if (url === `${AS_ORIGIN}/token`) {
          return new Response(null, { status: 307, headers: { location: redirectTarget } });
        }
        return json({ access_token: 'token-1', token_type: 'Bearer', expires_in: 3600 });
      };
    };
    const sent = {
      method: 'POST',
      headers: {
        Authorization: 'Basic Y2xpZW50OnNlY3JldA==',
        Cookie: 'session=person-session',
        'X-Api-Key': 'sign-in-key-header',
        'Api-Key': 'sign-in-key-alt-header',
      },
      body: 'grant_type=refresh_token',
    };

    stubDial('https://mcp.example.com/token');
    await dialMcpOAuthUrl(`${AS_ORIGIN}/token`, sent);
    expect(received.map(entry => entry.url)).toEqual([`${AS_ORIGIN}/token`, 'https://mcp.example.com/token']);
    // The first dial carries the credentials, as the caller sent them; the other origin sees none of them.
    expect(received[0]?.headers.get('authorization')).toBe('Basic Y2xpZW50OnNlY3JldA==');
    expect(received[1]?.headers.get('authorization')).toBeNull();
    expect(received[1]?.headers.get('cookie')).toBeNull();
    expect(received[1]?.headers.get('x-api-key')).toBeNull();
    expect(received[1]?.headers.get('api-key')).toBeNull();

    stubDial(`${AS_ORIGIN}/token-final`);
    await dialMcpOAuthUrl(`${AS_ORIGIN}/token`, sent);
    expect(received.map(entry => entry.url)).toEqual([`${AS_ORIGIN}/token`, `${AS_ORIGIN}/token-final`]);
    expect(received[1]?.headers.get('authorization')).toBe('Basic Y2xpZW50OnNlY3JldA==');
    expect(received[1]?.headers.get('cookie')).toBe('session=person-session');
    expect(received[1]?.headers.get('x-api-key')).toBe('sign-in-key-header');
    expect(received[1]?.headers.get('api-key')).toBe('sign-in-key-alt-header');
  });

  it('refuses to dial a token endpoint whose name does not resolve', async () => {
    const stores = newStores();
    const goneClient: OAuthClientRecord = {
      server: {
        authorizationEndpoint: `${AS_ORIGIN}/authorize`,
        tokenEndpoint: 'https://gone.example.com/token',
        codeChallengeMethodsSupported: ['S256'],
      },
      client: { clientId: 'cached-client', clientSecret: 'cached-secret' },
    };
    await stores.mcpServerStore.saveClient({ id: SERVER_ID, record: goneClient });
    const { dialed } = stubRecordingFetch({});

    const attempt = completeMcpAuthorization({
      tokenStore: stores.tokenStore,
      mcpServerStore: stores.mcpServerStore,
      pending: {
        state: 'state-1',
        id: SERVER_ID,
        userRef: USER_REF,
        mcpServerUrl: SERVER_URL,
        codeVerifier: 'verifier-1',
        returnTo: null,
      },
      code: 'auth-code-1',
    });
    await expect(attempt).rejects.toBeInstanceOf(McpOAuthAddressRefusedError);
    await expect(attempt).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('did not resolve'),
    });
    expect(dialed.some(url => url.includes('gone.example.com'))).toBe(false);
  });
});
