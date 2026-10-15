import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import type { Configuration } from 'openid-client';
import winston from 'winston';
import { createAuthRouter } from '../../../src/apis/auth';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth, initOidc } from '../../../src/auth/oidc';
import { OidcAuthenticator } from '../../../src/auth/oidcAuthenticator';
import configuration from '../../../src/config';

// An instance opened on the local network: the app and the sign-in service answer on this computer's address, and the
// same app is also opened at 127.0.0.1 on the same port.
jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  const OIDC = {
    OIDC_ISSUER_URL: 'http://192.168.1.20:5556/dex',
    OIDC_CLIENT_ID: 'network-client',
    OIDC_CLIENT_SECRET: 'network-secret',
    OIDC_USER_REFERENCE_CLAIM: 'sub',
    OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
    OIDC_USER_ROLE_CLAIM: 'email',
    OIDC_ADMIN_ROLE_VALUE: 'owner@example.com',
    OIDC_SCOPES: ['openid', 'profile', 'email'],
    OIDC_ALLOWED_EMAILS: [] as string[],
  };
  const config = {
    STANDALONE: false as const,
    PUBLIC_BASE_URL: 'http://192.168.1.20:8791',
    NODE_ENV: 'development',
    OIDC,
    PORT: 8790,
  };
  const publicBase = { ...actual.default, PUBLIC_BASE_URL: config.PUBLIC_BASE_URL, NODE_ENV: 'development' };
  return {
    ...actual,
    __esModule: true,
    default: config,
    getPublicBaseUrl: jest.fn(() => actual.getPublicBaseUrl(publicBase)),
    getPublicUiBasePath: jest.fn(() => actual.getPublicUiBasePath(publicBase)),
    isTrueFoundryModeEnabled: jest.fn(() => false),
  };
});

if (configuration.STANDALONE || !configuration.OIDC) {
  throw new Error('OIDC test configuration is missing');
}

const ISSUER = 'http://192.168.1.20:5556/dex';
const CLIENT_ID = 'network-client';
const STATE_COOKIE = 'oauth_state';
const ID_TOKEN_COOKIE = 'id_token';
const ACCESS_TOKEN = 'access-1';
const configuredOidc = configuration.OIDC;
const logger = winston.createLogger({ silent: true });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function cookieValue(res: Response, name: string): string | undefined {
  for (const entry of res.headers.getSetCookie()) {
    const first = entry.split(';')[0];
    if (first?.startsWith(`${name}=`)) {
      return first.slice(name.length + 1);
    }
  }
  return undefined;
}

describe('signing in to an instance opened on the local network', () => {
  const realFetch = globalThis.fetch;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: JWK;
  let client: Configuration;
  let tokenRedirectUris: string[];

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = 'test-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
  });

  beforeEach(async () => {
    tokenRedirectUris = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/keys`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          id_token_signing_alg_values_supported: ['RS256'],
          subject_types_supported: ['public'],
        });
      }
      if (url === `${ISSUER}/keys`) {
        return json({ keys: [publicJwk] });
      }
      if (url === `${ISSUER}/token` && init?.method === 'POST') {
        const body = new URLSearchParams(String(init.body));
        tokenRedirectUris.push(body.get('redirect_uri') ?? '');
        const digest = createHash('sha256').update(ACCESS_TOKEN).digest();
        const idToken = await new SignJWT({
          email: 'owner@example.com',
          at_hash: digest.subarray(0, digest.length / 2).toString('base64url'),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setSubject('owner')
          .setIssuedAt()
          .setExpirationTime('48h')
          .sign(privateKey);
        return json({ access_token: ACCESS_TOKEN, id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    };
    const discovered = await initOidc(configuredOidc);
    if (!discovered) {
      throw new Error('OIDC client was not initialized');
    }
    client = discovered;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    disableOidcAuth();
  });

  function router() {
    return createAuthRouter({
      oidcDiscovery: { client: () => client, stop: () => undefined },
      logger,
      authMiddleware: createAuthMiddleware(new OidcAuthenticator()),
    });
  }

  /** Signs in at `origin`: the login redirect, then the callback the IdP would send the browser back to. */
  async function signInAt(
    origin: string,
  ): Promise<{ redirectUri: string; callbackStatus: number; cookieSet: boolean }> {
    const app = router();
    const login = await app.request(`${origin}/login?return_to=/sessions/abc`, { redirect: 'manual' });
    const authorization = new URL(login.headers.get('location') ?? '');
    const redirectUri = authorization.searchParams.get('redirect_uri') ?? '';
    const stateCookie = cookieValue(login, STATE_COOKIE) ?? '';
    const state = authorization.searchParams.get('state') ?? '';
    const callbackUrl = new URL(redirectUri);
    const callback = await app.request(
      `${callbackUrl.origin}/callback?code=abc&state=${state}&iss=${encodeURIComponent(ISSUER)}`,
      { redirect: 'manual', headers: { Cookie: `${STATE_COOKIE}=${stateCookie}` } },
    );
    return {
      redirectUri,
      callbackStatus: callback.status,
      cookieSet: cookieValue(callback, ID_TOKEN_COOKIE) !== undefined,
    };
  }

  it('completes the round trip at the address other devices use', async () => {
    const result = await signInAt('http://192.168.1.20:8791');
    expect(result.redirectUri).toBe('http://192.168.1.20:8791/api/v1/auth/callback');
    expect(result).toMatchObject({ callbackStatus: 302, cookieSet: true });
    expect(tokenRedirectUris).toEqual(['http://192.168.1.20:8791/api/v1/auth/callback']);
  });

  it.each(['http://127.0.0.1:8791', 'http://localhost:8791'])(
    'completes the round trip at %s and returns there, so the sign-in cookies match',
    async origin => {
      const result = await signInAt(origin);
      expect(result.redirectUri).toBe(`${origin}/api/v1/auth/callback`);
      expect(result).toMatchObject({ callbackStatus: 302, cookieSet: true });
      expect(tokenRedirectUris).toEqual([`${origin}/api/v1/auth/callback`]);
    },
  );

  it.each(['http://127.0.0.1:9999', 'http://[::1]:8791', 'http://203.0.113.9:8791', 'https://127.0.0.1:8791'])(
    'never builds a return address from %s, which is not registered with the sign-in service',
    async origin => {
      const login = await router().request(`${origin}/login`, { redirect: 'manual' });
      const redirectUri = new URL(login.headers.get('location') ?? '').searchParams.get('redirect_uri');
      expect(redirectUri).toBe('http://192.168.1.20:8791/api/v1/auth/callback');
    },
  );
});
