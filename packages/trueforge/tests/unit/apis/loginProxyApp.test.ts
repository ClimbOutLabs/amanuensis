import { HTTPException } from 'hono/http-exception';
import type { Authenticator } from '../../../src/auth/authenticator';
import configuration from '../../../src/config';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const ISSUER = 'http://127.0.0.1:5556/dex';
const ORIGINS = ['http://127.0.0.1:8790', 'http://192.168.1.20:8790'];
const NO_EMAILS: string[] = [];
const OIDC_CONFIG = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: 'network-client',
  OIDC_CLIENT_SECRET: 'network-secret',
  OIDC_USER_REFERENCE_CLAIM: 'sub',
  OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
  OIDC_USER_ROLE_CLAIM: 'email',
  OIDC_ADMIN_ROLE_VALUE: 'owner@example.com',
  OIDC_SCOPES: ['openid', 'profile', 'email'],
  OIDC_ALLOWED_EMAILS: NO_EMAILS,
};

const signedOut: Authenticator = {
  authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
};

/** The whole app with sign-in on and a list of addresses, as the installer sets an instance up. */
describe('the sign-in pass-through in the running app', () => {
  const realFetch = globalThis.fetch;
  const saved = {
    OIDC: configuration.OIDC,
    PUBLIC_BASE_URL: configuration.PUBLIC_BASE_URL,
    ALLOWED_ORIGINS: configuration.ALLOWED_ORIGINS,
  };
  let upstream: string[];
  let server: ApprovalTestServer | undefined;

  beforeEach(() => {
    upstream = [];
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:5556/')) {
        upstream.push(url);
        return Promise.resolve(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
      }
      return realFetch(input, init);
    };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    Object.assign(configuration, saved);
    await server?.close();
    server = undefined;
  });

  async function start(allowedOrigins: string[]): Promise<ApprovalTestServer> {
    Object.assign(configuration, {
      OIDC: OIDC_CONFIG,
      PUBLIC_BASE_URL: 'http://127.0.0.1:8790',
      ALLOWED_ORIGINS: allowedOrigins,
    });
    server = await startApprovalTestServer({ authenticator: signedOut });
    return server;
  }

  it('proxies a listed address, refuses an unlisted Host with the words to fix it, and answers nothing else', async () => {
    const app = await start(ORIGINS);
    const listed = await app.request('http://192.168.1.20:8790/dex/auth?client_id=c', {
      headers: { host: '192.168.1.20:8790' },
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toBe('<html>login</html>');
    expect(listed.headers.get('x-frame-options')).toBe('DENY');
    expect(upstream).toEqual(['http://127.0.0.1:5556/dex/auth?client_id=c']);

    const unlisted = await app.request('http://192.168.1.99:8790/dex/auth', { headers: { host: '192.168.1.99:8790' } });
    expect(unlisted.status).toBe(421);
    expect(await unlisted.text()).toContain('aman doctor network --fix');
    expect(upstream).toHaveLength(1);

    const token = await app.request('http://192.168.1.20:8790/dex/token', {
      method: 'POST',
      headers: { host: '192.168.1.20:8790', origin: 'http://192.168.1.20:8790' },
    });
    expect(token.status).toBe(404);
    expect(upstream).toHaveLength(1);
  });

  it('has no /dex route at all when no addresses are listed', async () => {
    const app = await start([]);
    const res = await app.request('http://127.0.0.1:8790/dex/auth', { headers: { host: '127.0.0.1:8790' } });
    expect(res.status).toBe(404);
    expect(upstream).toEqual([]);
  });
});
