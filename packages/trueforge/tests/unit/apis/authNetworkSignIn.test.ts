import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import type { Configuration } from 'openid-client';
import winston from 'winston';
import { createAuthRouter } from '../../../src/apis/auth';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth, initOidc } from '../../../src/auth/oidc';
import { OidcAuthenticator } from '../../../src/auth/oidcAuthenticator';
import configuration from '../../../src/config';

// An instance opened on the local network: it answers at several addresses, signs in at the one a request came to, and
// reaches its sign-in service at an address of its own that no other device can use.
const ORIGINS = [
  'http://127.0.0.1:8791',
  'http://localhost:8791',
  'http://192.168.1.20:8791',
  'http://100.101.102.103:8791',
  'http://spark.local:8791',
  'http://spark.example.ts.net:8791',
  'https://aman.example.com',
];

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  const OIDC = {
    OIDC_ISSUER_URL: 'http://127.0.0.1:5556/dex',
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
    getAllowedOrigins: jest.fn(() => [
      'http://127.0.0.1:8791',
      'http://localhost:8791',
      'http://192.168.1.20:8791',
      'http://100.101.102.103:8791',
      'http://spark.local:8791',
      'http://spark.example.ts.net:8791',
      'https://aman.example.com',
    ]),
    isTrueFoundryModeEnabled: jest.fn(() => false),
  };
});

if (configuration.STANDALONE || !configuration.OIDC) {
  throw new Error('OIDC test configuration is missing');
}

const ISSUER = 'http://127.0.0.1:5556/dex';
const CLIENT_ID = 'network-client';
const STATE_COOKIE = 'oauth_state';
const ID_TOKEN_COOKIE = 'id_token';
const ACCESS_TOKEN = 'access-1';
const configuredOidc = configuration.OIDC;
const logger = winston.createLogger({ silent: true });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function cookieHeader(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find(entry => entry.startsWith(`${name}=`));
}

function cookieValue(res: Response, name: string): string | undefined {
  return cookieHeader(res, name)
    ?.split(';')[0]
    ?.slice(name.length + 1);
}

/** A browser always sends Host; the test client does not, so it is added from the URL unless a test sets its own. */
function browserRequest(
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  url: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (!headers.has('host')) {
    headers.set('host', new URL(url).host);
  }
  return app.request(url, { ...init, headers });
}

describe('signing in to an instance opened on several addresses', () => {
  const realFetch = globalThis.fetch;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: JWK;
  let client: Configuration;
  let tokenRedirectUris: string[];
  let upstream: string[];

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
    upstream = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      upstream.push(url);
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

  /** Signs in at `origin`: the login redirect, then the callback the sign-in service would send the browser back to. */
  async function signInAt(origin: string) {
    const app = router();
    const login = await browserRequest(app, `${origin}/login?return_to=/sessions/abc`, { redirect: 'manual' });
    const authorization = new URL(login.headers.get('location') ?? 'http://missing.invalid/');
    const redirectUri = authorization.searchParams.get('redirect_uri') ?? '';
    const stateCookie = cookieValue(login, STATE_COOKIE) ?? '';
    const state = authorization.searchParams.get('state') ?? '';
    const callback = await browserRequest(
      app,
      `${origin}/callback?code=abc&state=${state}&iss=${encodeURIComponent(ISSUER)}`,
      {
        redirect: 'manual',
        headers: { Cookie: `${STATE_COOKIE}=${stateCookie}` },
      },
    );
    return { login, authorization, redirectUri, callback, stateCookie };
  }

  it.each(ORIGINS)('completes the round trip at %s, from its own address to its own address', async origin => {
    const { authorization, redirectUri, callback } = await signInAt(origin);
    expect(authorization.origin).toBe(origin);
    expect(authorization.pathname).toBe('/dex/auth');
    expect(redirectUri).toBe(`${origin}/api/v1/auth/callback`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/sessions/abc');
    expect(cookieValue(callback, ID_TOKEN_COOKIE)).toBeTruthy();
    expect(tokenRedirectUris).toEqual([`${origin}/api/v1/auth/callback`]);
  });

  it('talks to the sign-in service only at its own internal address, and the token still names that issuer', async () => {
    await signInAt('http://100.101.102.103:8791');
    expect(upstream.every(url => url.startsWith(`${ISSUER}/`))).toBe(true);
  });

  it.each([
    'http://192.168.1.21:8791',
    'http://192.168.1.20:9999',
    'http://evil.example:8791',
    'http://203.0.113.9:8791',
    'http://[::1]:8791',
    'http://spark:8791',
  ])('gives %s a plain page, no redirect and no cookie', async origin => {
    const app = router();
    for (const path of ['/login', '/callback?code=a&state=b']) {
      const res = await browserRequest(app, `${origin}${path}`, { redirect: 'manual' });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.text()).toBe('This address is not one Aman is set up for.');
    }
  });

  it('cannot be steered to another host by anything a request carries', async () => {
    const app = router();
    const attacks: Record<string, string>[] = [
      { 'x-forwarded-host': 'evil.example' },
      { forwarded: 'host=evil.example;proto=https' },
      { origin: 'http://evil.example' },
      { referer: 'http://evil.example/' },
      { 'x-original-host': 'evil.example', 'x-forwarded-proto': 'https' },
    ];
    for (const headers of attacks) {
      const res = await browserRequest(app, 'http://192.168.1.20:8791/login?return_to=http://evil.example/', {
        redirect: 'manual',
        headers,
      });
      const location = new URL(res.headers.get('location') ?? 'http://missing.invalid/');
      expect(location.origin).toBe('http://192.168.1.20:8791');
      expect(location.searchParams.get('redirect_uri')).toBe('http://192.168.1.20:8791/api/v1/auth/callback');
    }
    const odd = await browserRequest(app, 'http://192.168.1.20:8791/login', {
      redirect: 'manual',
      headers: { host: 'evil.example' },
    });
    expect(odd.status).toBe(400);
  });

  it('sets the sign-in cookies without Secure over plain http and with it over https', async () => {
    const plain = await signInAt('http://192.168.1.20:8791');
    expect(cookieHeader(plain.login, STATE_COOKIE)).not.toMatch(/;\s*Secure/i);
    expect(cookieHeader(plain.callback, ID_TOKEN_COOKIE)).not.toMatch(/;\s*Secure/i);
    expect(cookieHeader(plain.login, STATE_COOKIE)).toMatch(/HttpOnly/i);
    expect(cookieHeader(plain.login, STATE_COOKIE)).toMatch(/SameSite=Lax/i);
    const loopback = await signInAt('http://127.0.0.1:8791');
    expect(cookieHeader(loopback.login, STATE_COOKIE)).not.toMatch(/;\s*Secure/i);
    const tls = await signInAt('https://aman.example.com');
    expect(cookieHeader(tls.login, STATE_COOKIE)).toMatch(/;\s*Secure/i);
    expect(cookieHeader(tls.callback, ID_TOKEN_COOKIE)).toMatch(/;\s*Secure/i);
  });
});
