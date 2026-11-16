/**
 * The MCP OAuth callback and paired terminal keys. The callback router is mounted
 * without the auth middleware, so the terminal scope has to be applied where the
 * session is resolved: a terminal key is a chat credential, and it must be refused
 * at the callback before the pending authorization is consumed, exactly as if no
 * session had been presented. Everyone here is made up: Nora owns the instance and
 * Pippa is her terminal.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createMcpOAuthRouter } from '../../../src/apis/mcpOAuth';
import { createTerminalPairingRouter } from '../../../src/apis/terminalPairings';
import { createAuthMiddleware, tryAuthenticate } from '../../../src/auth/middleware';
import { disableOidcAuth, enableOidcAuth, initOidc } from '../../../src/auth/oidc';
import { OidcAuthenticator } from '../../../src/auth/oidcAuthenticator';
import type { OIDCConfig } from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { TerminalKeyStore } from '../../../src/db/terminalKeyStore';
import type { IOAuthClientStore, IOAuthTokenStore, OAuthPendingAuthorization } from '../../../src/mcp/auth/types';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'harness-client';

const OIDC_CONFIG: OIDCConfig = {
  OIDC_ISSUER_URL: `${ISSUER}/`,
  OIDC_CLIENT_ID: AUDIENCE,
  OIDC_CLIENT_SECRET: 'harness-secret',
  OIDC_USER_REFERENCE_CLAIM: 'sub',
  OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
  OIDC_USER_ROLE_CLAIM: 'groups',
  OIDC_ADMIN_ROLE_VALUE: 'admin',
  OIDC_SCOPES: ['openid', 'profile', 'email', 'groups'],
  OIDC_ALLOWED_EMAILS: [],
  OIDC_REQUIRE_VERIFIED_EMAIL: false,
};

const StartResponseSchema = z.object({
  data: z.object({ pairing_id: z.string(), code: z.string(), confirm_url: z.string(), expires_at: z.string() }),
});
const CompleteResponseSchema = z.object({
  data: z.object({
    status: z.enum(['waiting', 'paired']),
    terminal_key: z.string().optional(),
    device_name: z.string().optional(),
  }),
});

interface Harness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  consumedStates: string[];
  seedPending: (pending: OAuthPendingAuthorization) => void;
  noraToken: () => Promise<string>;
}

function postJson(body: unknown, headers?: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

describe('MCP OAuth callback with a paired terminal key', () => {
  const realFetch = globalThis.fetch;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let oidcClient: Awaited<ReturnType<typeof initOidc>>;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = 'test-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    globalThis.fetch = async input => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${ISSUER}/jwks`) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    };
    oidcClient = await initOidc(OIDC_CONFIG);
    if (!oidcClient) {
      throw new Error('OIDC client was not initialized');
    }
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    disableOidcAuth();
  });

  beforeEach(() => {
    if (!oidcClient) {
      throw new Error('OIDC client was not initialized');
    }
    enableOidcAuth({ client: oidcClient, oidcConfig: OIDC_CONFIG });
  });

  async function noraToken(): Promise<string> {
    return new SignJWT({ groups: ['admin'], name: 'Nora' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('nora')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  async function buildHarness(): Promise<Harness> {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const terminalKeyStore = new TerminalKeyStore(db);
    const auditStore = new SentinelAuditStore(db);
    const logger = createLogger({ silent: true });
    const authenticator = new OidcAuthenticator({ terminalKeyStore });
    const authMiddleware = createAuthMiddleware(authenticator);

    const app = new OpenAPIHono();
    app.onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ error: { message: error.message } }, error.status);
      }
      throw error;
    });
    app.route(
      '/api/v1/terminal-pairings',
      createTerminalPairingRouter({ terminalKeyStore, audit: auditStore, logger, authMiddleware }),
    );
    // The callback exactly as app.ts mounts it: no auth middleware, the session
    // resolved by calling the authenticator directly.
    const pendings = new Map<string, OAuthPendingAuthorization>();
    const consumedStates: string[] = [];
    const tokenStore: IOAuthTokenStore = {
      savePendingAuthorization: async pending => {
        pendings.set(pending.state, pending);
      },
      consumePendingAuthorization: async ({ state }) => {
        consumedStates.push(state);
        const pending = pendings.get(state);
        pendings.delete(state);
        return pending;
      },
      saveToken: async () => undefined,
      getToken: async () => undefined,
      getTokens: async () => new Map(),
      deleteToken: async () => undefined,
      deleteTokensForServer: async () => undefined,
      deletePendingAuthorizationsForServer: async () => undefined,
    };
    const clientStore: IOAuthClientStore = {
      saveClient: async () => undefined,
      getClient: async () => undefined,
      deleteClient: async () => undefined,
    };
    app.route(
      '/api/v1/mcp-servers/oauth',
      createMcpOAuthRouter({
        tokenStore,
        mcpServerStore: clientStore,
        logger,
        resolveSession: c => tryAuthenticate({ authenticator, context: c }),
      }),
    );
    return {
      request: async (path, init) => app.request(path, init),
      consumedStates,
      seedPending: pending => {
        pendings.set(pending.state, pending);
      },
      noraToken,
    };
  }

  async function pair(harness: Harness): Promise<string> {
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(started.status).toBe(201);
    const start = StartResponseSchema.parse(await started.json());
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);
    const completed = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(completed.status).toBe(200);
    const completion = CompleteResponseSchema.parse(await completed.json());
    if (completion.data.status !== 'paired' || completion.data.terminal_key === undefined) {
      throw new Error('the pairing did not hand over a key');
    }
    return completion.data.terminal_key;
  }

  function pendingFor(state: string, userRef: string): OAuthPendingAuthorization {
    return {
      state,
      id: 'srv-1',
      userRef,
      mcpServerUrl: 'https://mcp.example.com',
      codeVerifier: 'verifier',
      returnTo: null,
    };
  }

  it('refuses a terminal key before the pending authorization is consumed', async () => {
    const harness = await buildHarness();
    const key = await pair(harness);
    harness.seedPending(pendingFor('st-key', 'nora'));

    const refused = await harness.request('/api/v1/mcp-servers/oauth/callback?state=st-key&code=code-1', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Authentication required to complete OAuth');
    // The state was never consumed: the owner's real browser can still finish it.
    expect(harness.consumedStates).not.toContain('st-key');
  });

  it('still completes the flow for the owner session itself', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    harness.seedPending(pendingFor('st-owner', 'nora'));

    const completed = await harness.request('/api/v1/mcp-servers/oauth/callback?state=st-owner&code=code-1', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // The session resolves as Nora, the state is consumed, and the flow reaches the
    // token exchange step, which fails only because no OAuth client is registered
    // in this harness.
    expect(completed.status).toBe(400);
    expect(await completed.text()).toContain('No OAuth client registered');
    expect(harness.consumedStates).toContain('st-owner');
  });

  it('refuses with no credential before the state is consumed', async () => {
    const harness = await buildHarness();
    harness.seedPending(pendingFor('st-none', 'nora'));

    const refused = await harness.request('/api/v1/mcp-servers/oauth/callback?state=st-none&code=code-1');

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Authentication required to complete OAuth');
    expect(harness.consumedStates).not.toContain('st-none');
  });
});
