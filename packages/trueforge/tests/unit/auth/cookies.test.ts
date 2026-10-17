import { Hono } from 'hono';
import {
  ACCESS_TOKEN_COOKIE,
  clearAuthCookie,
  ID_TOKEN_COOKIE,
  OAUTH_STATE_COOKIE,
  readAccessTokenCookie,
  readIdTokenCookie,
  setAuthCookie,
} from '../../../src/auth/cookies';
import { extractRequestToken } from '../../../src/auth/token';
import { getAuthCookieSuffix, getPublicBaseUrl } from '../../../src/config';

jest.mock('../../../src/config', () => ({
  getAuthCookieSuffix: jest.fn(() => ''),
  getPublicBaseUrl: jest.fn(() => 'http://localhost:8790'),
  getAllowedOrigins: jest.fn((): string[] => []),
}));

function appFor() {
  const app = new Hono();
  app.get('/set', c => {
    setAuthCookie({ context: c, name: ID_TOKEN_COOKIE, value: 'tok', maxAgeSeconds: 60 });
    setAuthCookie({ context: c, name: OAUTH_STATE_COOKIE, value: '{}', maxAgeSeconds: 60 });
    return c.body(null, 204);
  });
  app.get('/clear', c => {
    clearAuthCookie({ context: c, name: ID_TOKEN_COOKIE });
    return c.body(null, 204);
  });
  app.get('/read', c =>
    c.json({
      id: readIdTokenCookie({ context: c }) ?? null,
      access: readAccessTokenCookie({ context: c }) ?? null,
      token: extractRequestToken(c) ?? null,
    }),
  );
  return app;
}

function cookieNames(res: Response): string[] {
  return res.headers.getSetCookie().map(entry => entry.split('=')[0] ?? '');
}

describe('auth cookie names', () => {
  afterEach(() => {
    jest.mocked(getAuthCookieSuffix).mockReturnValue('');
    jest.mocked(getPublicBaseUrl).mockReturnValue('http://localhost:8790');
  });

  it('uses the plain names without a suffix', async () => {
    const res = await appFor().request('/set');

    expect(cookieNames(res)).toEqual(['id_token', 'oauth_state']);
  });

  it('appends the suffix to every auth cookie, and names differ across three instances', async () => {
    const names: string[][] = [];
    for (const suffix of ['_a', '_b', '_c']) {
      jest.mocked(getAuthCookieSuffix).mockReturnValue(suffix);
      names.push(cookieNames(await appFor().request('/set')));
    }

    expect(names).toEqual([
      ['id_token_a', 'oauth_state_a'],
      ['id_token_b', 'oauth_state_b'],
      ['id_token_c', 'oauth_state_c'],
    ]);
  });

  it('reads only its own instance cookies, including the access token cookie', async () => {
    jest.mocked(getAuthCookieSuffix).mockReturnValue('_a');
    const res = await appFor().request('/read', {
      headers: { cookie: `id_token_b=other-id; ${ACCESS_TOKEN_COOKIE}_b=other-access; id_token_a=mine-id` },
    });

    expect(await res.json()).toEqual({ id: 'mine-id', access: null, token: 'mine-id' });

    const own = await appFor().request('/read', { headers: { cookie: `${ACCESS_TOKEN_COOKIE}_a=mine-access` } });
    expect(await own.json()).toEqual({ id: null, access: 'mine-access', token: 'mine-access' });
  });

  it('ignores another instance cookie and the unsuffixed name when a suffix is set', async () => {
    jest.mocked(getAuthCookieSuffix).mockReturnValue('_a');
    const res = await appFor().request('/read', { headers: { cookie: 'id_token=plain; id_token_b=other' } });

    expect(await res.json()).toEqual({ id: null, access: null, token: null });
  });

  it('clears only the suffixed cookie of this instance', async () => {
    jest.mocked(getAuthCookieSuffix).mockReturnValue('_a');
    const res = await appFor().request('/clear');

    expect(cookieNames(res)).toEqual(['id_token_a']);
  });

  it('marks cookies Secure only when the public URL is https', async () => {
    const insecure = (await appFor().request('/set')).headers.getSetCookie();
    expect(insecure.every(entry => !entry.includes('Secure'))).toBe(true);

    jest.mocked(getPublicBaseUrl).mockReturnValue('https://amanuensis.example');
    const secure = (await appFor().request('/set')).headers.getSetCookie();
    expect(secure.every(entry => entry.includes('Secure') && entry.includes('HttpOnly'))).toBe(true);
    expect(secure.every(entry => entry.includes('SameSite=Lax'))).toBe(true);
  });
});
