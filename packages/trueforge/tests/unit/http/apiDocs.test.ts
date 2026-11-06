import { OpenAPIHono } from '@hono/zod-openapi';

import { mountApiDocs } from '../../../src/http/apiDocs';

function appWithDocs(uiBasePath = '/'): OpenAPIHono {
  const app = new OpenAPIHono();
  mountApiDocs(app, { uiBasePath, openApiSpecPath: `${uiBasePath}api/v1/openapi.json` });
  return app;
}

describe('mountApiDocs', () => {
  it('serves the docs page with Swagger UI from this server, not a CDN', async () => {
    const response = await appWithDocs('/aman/').request('/api/v1/docs');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/aman/api/v1/docs/assets/swagger-ui-dist/swagger-ui.css"');
    expect(html).toContain('src="/aman/api/v1/docs/assets/swagger-ui-dist/swagger-ui-bundle.js"');
    expect(html).toContain("validatorUrl: 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  it('serves the two Swagger UI files and nothing else from the package', async () => {
    const app = appWithDocs();
    const css = await app.request('/api/v1/docs/assets/swagger-ui-dist/swagger-ui.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const js = await app.request('/api/v1/docs/assets/swagger-ui-dist/swagger-ui-bundle.js');
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);

    for (const file of ['package.json', 'index.html', '..%2Fpackage.json', 'swagger-ui.css.map']) {
      const response = await app.request(`/api/v1/docs/assets/swagger-ui-dist/${file}`);
      expect(response.status).toBe(404);
    }
  });
});
