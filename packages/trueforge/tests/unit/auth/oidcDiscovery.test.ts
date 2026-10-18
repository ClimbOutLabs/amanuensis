import { exportJWK, generateKeyPair } from 'jose';
import { createServer, type Server } from 'node:http';
import winston from 'winston';
import {
  disableOidcAuth,
  discoveryRetryDelayMs,
  getOidcVerify,
  initOidc,
  startOidcDiscovery,
} from '../../../src/auth/oidc';
import type { OIDCConfig } from '../../../src/config';

const logger = winston.createLogger({ silent: true });

function oidcConfig(issuerUrl: string): OIDCConfig {
  return {
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: 'client-a',
    OIDC_CLIENT_SECRET: 'secret-a',
    OIDC_USER_REFERENCE_CLAIM: 'sub',
    OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
    OIDC_USER_ROLE_CLAIM: 'email',
    OIDC_ADMIN_ROLE_VALUE: 'owner@example.com',
    OIDC_SCOPES: ['openid', 'profile', 'email'],
    OIDC_ALLOWED_EMAILS: ['owner@example.com'],
    OIDC_REQUIRE_VERIFIED_EMAIL: false,
  };
}

function portOf(running: Server): number {
  const address = running.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server is not listening on a TCP port');
  }
  return address.port;
}

describe('discoveryRetryDelayMs', () => {
  it('doubles from 2 s and caps at 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(discoveryRetryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe('startOidcDiscovery', () => {
  const realFetch = globalThis.fetch;
  const ISSUER = 'https://issuer.example.com';

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = realFetch;
    disableOidcAuth();
  });

  function stubFetch(params: { reachable: () => boolean; calls: string[] }): void {
    globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      params.calls.push(url);
      if (!params.reachable()) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return Promise.resolve(
          new Response(
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
          ),
        );
      }
      return Promise.resolve(new Response('unexpected', { status: 404 }));
    };
  }

  it('returns immediately with no client while the issuer is unreachable, then retries with backoff until it answers', async () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    let reachable = false;
    stubFetch({ reachable: () => reachable, calls });

    const handle = startOidcDiscovery({ oidc: oidcConfig(`${ISSUER}/`), logger });

    expect(handle.client()).toBeUndefined();
    expect(getOidcVerify()).toBeNull();
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    // Second wait is 4 s, third is 8 s.
    await jest.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    reachable = true;
    await jest.advanceTimersByTimeAsync(8_000);
    expect(handle.client()).toBeDefined();
    expect(getOidcVerify()).not.toBeNull();

    const afterSuccess = calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(afterSuccess);
    handle.stop();
  });

  it('stops retrying after stop()', async () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    stubFetch({ reachable: () => false, calls });

    const handle = startOidcDiscovery({ oidc: oidcConfig(`${ISSUER}/`), logger });
    await jest.advanceTimersByTimeAsync(0);
    handle.stop();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(calls).toHaveLength(1);
  });
});

describe('initOidc issuer transport', () => {
  let server: Server | undefined;
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    disableOidcAuth();
    const running = server;
    server = undefined;
    if (running) {
      await new Promise<void>(resolve => running.close(() => resolve()));
    }
  });

  async function startLoopbackIdp(): Promise<string> {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const http = createServer((req, res) => {
      const base = `http://127.0.0.1:${String(portOf(http))}`;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/dex/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer: `${base}/dex`,
            authorization_endpoint: `${base}/dex/auth`,
            token_endpoint: `${base}/dex/token`,
            jwks_uri: `${base}/dex/keys`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          }),
        );
      } else if (req.url === '/dex/keys') {
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'k', alg: 'RS256', use: 'sig' }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server = http;
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String(portOf(http))}/dex`;
  }

  it('discovers a plain-http loopback issuer', async () => {
    const issuer = await startLoopbackIdp();

    const client = await initOidc(oidcConfig(issuer));

    expect(client?.serverMetadata().issuer).toBe(issuer);
    expect(getOidcVerify()?.issuer).toBe(issuer);
  });

  it('keeps https issuers on the strict transport (no insecure requests)', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));

    await expect(initOidc(oidcConfig('https://issuer.example.com'))).rejects.toThrow();
  });
});
