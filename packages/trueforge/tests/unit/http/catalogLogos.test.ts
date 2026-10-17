import { OpenAPIHono } from '@hono/zod-openapi';

import { mountCatalogLogos } from '../../../src/http/catalogLogos';

const ASSETS = 'https://assets.example';

function svgResponse(body = '<svg xmlns="http://www.w3.org/2000/svg"/>'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
}

function appWith(fetchFn: jest.Mock): OpenAPIHono {
  const app = new OpenAPIHono();
  mountCatalogLogos(app, { logos: [`${ASSETS}/linear.svg`, undefined, 'not a url'], fetchFn });
  return app;
}

describe('mountCatalogLogos', () => {
  it('serves a logo from the catalog origin with a script-proof header set, and caches it', async () => {
    const fetchFn = jest.fn(async () => svgResponse());
    const app = appWith(fetchFn);

    const first = await app.request('/catalog-logos/https/assets.example/openai-dark.svg');
    const second = await app.request('/catalog-logos/https/assets.example/openai-dark.svg');

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
      expect((await app.request(url)).status).toBe(404);
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
      expect((await app.request(url)).status).toBe(404);
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
      expect((await app.request(`/catalog-logos/https/assets.example/${name}.svg`)).status).toBe(404);
    }
  });
});
