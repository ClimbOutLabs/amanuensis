import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import type { Authenticator } from '../../../src/auth/authenticator';
import { createUiSessionAuthMiddleware } from '../../../src/auth/middleware';
import { mountCatalogLogos } from '../../../src/http/catalogLogos';

const ASSETS = 'https://assets.example';
const SIGNED_IN = { headers: { cookie: 'session=signed-in' } };

/** Signed in when the request carries the session cookie, as a browser `<img>` load does. */
const cookieAuthenticator: Authenticator = {
  authenticate: async c => {
    if (c.req.header('cookie') !== SIGNED_IN.headers.cookie) {
      throw new HTTPException(401, { message: 'Sign-in required' });
    }
    return {
      tenant_id: 'default',
      subject: { id: 'owner', type: 'user', display_name: 'Owner' },
      roles: [],
      user_credential: null,
    };
  },
};

function svgResponse(body = '<svg xmlns="http://www.w3.org/2000/svg"/>'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
}

function appWith(fetchFn: jest.Mock): OpenAPIHono {
  const app = new OpenAPIHono();
  mountCatalogLogos(app, {
    logos: [`${ASSETS}/linear.svg`, undefined, 'not a url'],
    authMiddleware: createUiSessionAuthMiddleware(cookieAuthenticator),
    fetchFn,
  });
  return app;
}

describe('mountCatalogLogos', () => {
  it('refuses a caller who is not signed in or sends a bearer token, without fetching, and serves a signed-in browser', async () => {
    const fetchFn = jest.fn(async () => svgResponse());
    const app = appWith(fetchFn);
    const url = '/catalog-logos/https/assets.example/openai.svg';

    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { headers: { ...SIGNED_IN.headers, authorization: 'Bearer agent' } })).status).toBe(
      401,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect((await app.request(url, SIGNED_IN)).status).toBe(200);
  });

  it('serves a logo from the catalog origin with a script-proof header set, and caches it', async () => {
    const fetchFn = jest.fn(async () => svgResponse());
    const app = appWith(fetchFn);

    const first = await app.request('/catalog-logos/https/assets.example/openai-dark.svg', SIGNED_IN);
    const second = await app.request('/catalog-logos/https/assets.example/openai-dark.svg', SIGNED_IN);

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/svg+xml');
    expect(first.headers.get('content-security-policy')).toMatch(/^sandbox;/);
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await second.text()).toContain('<svg');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(`${ASSETS}/openai-dark.svg`, expect.objectContaining({ redirect: 'error' }));
  });

  it('refuses origins the catalogs do not name, without fetching', async () => {
    const fetchFn = jest.fn(async () => svgResponse());
    const app = appWith(fetchFn);

    for (const url of [
      '/catalog-logos/https/evil.example/x.svg',
      '/catalog-logos/http/assets.example/x.svg',
      '/catalog-logos/ftp/assets.example/x.svg',
      '/catalog-logos/https/assets.example@evil.example/x.svg',
    ]) {
      expect((await app.request(url, SIGNED_IN)).status).toBe(404);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses paths that are not a plain image file', async () => {
    const fetchFn = jest.fn(async () => svgResponse());
    const app = appWith(fetchFn);

    for (const url of [
      '/catalog-logos/https/assets.example/x.html',
      '/catalog-logos/https/assets.example/a/../../x.svg',
      '/catalog-logos/https/assets.example/x.svg%3Fa=b',
      '/catalog-logos/https/assets.example/',
    ]) {
      expect((await app.request(url, SIGNED_IN)).status).toBe(404);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not pass through non-image, failed or oversized upstream answers', async () => {
    const app = appWith(
      jest
        .fn()
        .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
        .mockResolvedValueOnce(new Response('nope', { status: 404, headers: { 'content-type': 'image/png' } }))
        .mockResolvedValueOnce(svgResponse('x'.repeat(300 * 1024)))
        .mockRejectedValueOnce(new Error('redirect')),
    );

    for (const name of ['a', 'b', 'c', 'd']) {
      expect((await app.request(`/catalog-logos/https/assets.example/${name}.svg`, SIGNED_IN)).status).toBe(404);
    }
  });
});
