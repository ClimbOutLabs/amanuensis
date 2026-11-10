import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import type { Authenticator } from '../../../src/auth/authenticator';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { mountApiDocs } from '../../../src/http/apiDocs';

const SIGNED_IN: Authenticator = {
  authenticate: () => Promise.resolve(STANDALONE_REQUEST_CONTEXT),
};

const NOT_SIGNED_IN: Authenticator = {
  authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
};

function appWithDocs(uiBasePath = '/', authenticator: Authenticator = SIGNED_IN): OpenAPIHono {
  const app = new OpenAPIHono();
  mountApiDocs(app, {
    uiBasePath,
    openApiSpecPath: `${uiBasePath}api/v1/openapi.json`,
    authMiddleware: createAuthMiddleware(authenticator),
  });
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

  it('refuses the docs page and its files to a caller who is not signed in', async () => {
    const app = appWithDocs('/', NOT_SIGNED_IN);
    const page = await app.request('/api/v1/docs');
    expect(page.status).toBe(401);
    for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
      const response = await app.request(`/api/v1/docs/assets/swagger-ui-dist/${file}`);
      expect(response.status).toBe(401);
    }
  });
});
