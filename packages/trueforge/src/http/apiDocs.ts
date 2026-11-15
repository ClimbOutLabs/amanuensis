import { swaggerUI } from '@hono/swagger-ui';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import getSwaggerUiDistPath from 'swagger-ui-dist/absolute-path.js';

export const API_DOCS_PATH = '/api/v1/docs';
const ASSETS_PATH = `${API_DOCS_PATH}/assets`;

/** The only files the page loads; the docs page names them under `<assets>/swagger-ui-dist/`. */
const SWAGGER_UI_FILES: Readonly<Record<string, string>> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
};

// The page's own bootstrap script is inline, so script-src needs 'unsafe-inline'; everything else
// stays on this origin, which is what keeps the docs page from loading anything from another site.
const API_DOCS_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";

/**
 * Interactive API docs at `/api/v1/docs`. Swagger UI's script and stylesheet are served from the
 * installed package rather than a CDN, and the spec validator (a call to swagger.io) is off.
 * The page and its files sit behind sign-in like the rest of the API, so `authMiddleware` gates
 * both routes; the browser carries the session cookie for the page, its files and the spec.
 */
export function mountApiDocs(
  app: OpenAPIHono,
  options: { uiBasePath: string; openApiSpecPath: string; authMiddleware: MiddlewareHandler },
): void {
  const cache = new Map<string, Uint8Array>();
  const page = swaggerUI({
    url: options.openApiSpecPath,
    baseUrl: `${options.uiBasePath}${ASSETS_PATH.slice(1)}`,
    validatorUrl: 'none',
  });

  app.get(API_DOCS_PATH, options.authMiddleware, async (c, next) => {
    c.header('Content-Security-Policy', API_DOCS_CSP);
    c.header('Referrer-Policy', 'no-referrer');
    return page(c, next);
  });

  app.get(`${ASSETS_PATH}/swagger-ui-dist/:file`, options.authMiddleware, c => {
    const file = c.req.param('file');
    const contentType = Object.hasOwn(SWAGGER_UI_FILES, file) ? SWAGGER_UI_FILES[file] : undefined;
    if (contentType === undefined) {
      return c.notFound();
    }
    let body = cache.get(file);
    if (body === undefined) {
      body = new Uint8Array(readFileSync(path.join(getSwaggerUiDistPath(), file)));
      cache.set(file, body);
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
