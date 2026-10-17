import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

export const CATALOG_LOGOS_PREFIX = '/catalog-logos';

const MAX_LOGO_BYTES = 256 * 1024;
const MAX_CACHED_LOGOS = 256;
const FETCH_TIMEOUT_MS = 5000;
const LOGO_PATH_RE = /^(?:\/[A-Za-z0-9._-]+)+\.(?:svg|png|jpg|jpeg|webp|gif)$/i;
const IMAGE_TYPE_RE = /^image\/(?:svg\+xml|png|jpeg|webp|gif)(?:;|$)/i;

interface CachedLogo {
  contentType: string;
  body: Uint8Array;
}

function logoOrigin(logo: string): string | undefined {
  try {
    const url = new URL(logo);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves catalog logos from the app's own origin so the shell CSP never has to admit the assets
 * host. Only simple image paths on origins the shipped catalogs already name are fetched. Logos only
 * appear after sign-in, so `authMiddleware` gates the route; `<img>` loads carry the session cookie.
 */
export function mountCatalogLogos(
  app: OpenAPIHono,
  options: { logos: Iterable<string | undefined>; authMiddleware: MiddlewareHandler; fetchFn?: typeof fetch },
): void {
  const fetchFn = options.fetchFn ?? fetch;
  const origins = new Set<string>();
  for (const logo of options.logos) {
    const origin = logo === undefined ? undefined : logoOrigin(logo);
    if (origin !== undefined) {
      origins.add(origin);
    }
  }
  const cache = new Map<string, CachedLogo>();

  async function load(url: string): Promise<CachedLogo | undefined> {
    const cached = cache.get(url);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const upstream = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.ok || !IMAGE_TYPE_RE.test(contentType)) {
        return undefined;
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength > MAX_LOGO_BYTES) {
        return undefined;
      }
      const logo = { contentType, body };
      if (cache.size >= MAX_CACHED_LOGOS) {
        cache.clear();
      }
      cache.set(url, logo);
      return logo;
    } catch {
      return undefined;
    }
  }

  app.get(`${CATALOG_LOGOS_PREFIX}/:scheme/:host/*`, options.authMiddleware, async c => {
    const { scheme, host } = c.req.param();
    const filePath = c.req.path.slice(`${CATALOG_LOGOS_PREFIX}/${scheme}/${host}`.length);
    if ((scheme !== 'https' && scheme !== 'http') || !LOGO_PATH_RE.test(filePath)) {
      return c.notFound();
    }
    const origin = logoOrigin(`${scheme}://${host}`);
    if (origin === undefined || !origins.has(origin)) {
      return c.notFound();
    }
    const logo = await load(`${origin}${filePath}`);
    if (logo === undefined) {
      return c.notFound();
    }
    return new Response(logo.body, {
      status: 200,
      headers: {
        'Content-Type': logo.contentType,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        // An SVG opened directly must not run script on the app origin.
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });
}
