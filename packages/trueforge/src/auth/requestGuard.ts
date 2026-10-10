import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { isLoopbackHost } from '../config';
import { readBearerToken } from './token';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_ORIGIN_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** Reachable without a browser session: probes, the service-key route, and the connector OAuth redirect. */
const ORIGIN_EXEMPT_PATHS = ['/healthz', '/api/internal/schedules', '/api/v1/mcp-servers/oauth'];

/** Default ports are dropped so `example.com` and `example.com:443` compare equal. */
function canonicalPort(port: string): string {
  return port === '80' || port === '443' ? '' : port;
}

function parseHostHeader(raw: string): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(`http://${raw}`);
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined;
    }
    return { hostname: url.hostname, port: canonicalPort(url.port) };
  } catch {
    return undefined;
  }
}

function isPathExempt(path: string): boolean {
  return ORIGIN_EXEMPT_PATHS.some(exempt => path === exempt || path.startsWith(`${exempt}/`));
}

/**
 * Standalone request guard for cookie-authenticated sessions. Forwarded-* headers are never read.
 * - Host must be a loopback name on the instance port or the public URL's host, else 421
 *   (defeats DNS rebinding). A request with no Host header passes: browsers always send one.
 * - State-changing requests need a same-origin signal: an allowed Origin, else
 *   `Sec-Fetch-Site: same-origin|none`, else a Bearer header; otherwise 403.
 */
export function createRequestGuardMiddleware(options: { port: number; publicBaseUrl: string }): MiddlewareHandler {
  const publicUrl = new URL(options.publicBaseUrl);
  const publicHost = { hostname: publicUrl.hostname, port: canonicalPort(publicUrl.port) };
  const instancePort = canonicalPort(String(options.port));
  const allowedOrigins = new Set([
    publicUrl.origin,
    ...LOOPBACK_ORIGIN_HOSTS.map(host => `http://${host}:${String(options.port)}`),
  ]);

  return async (c, next) => {
    const path = c.req.path;
    if (path === '/healthz') {
      return next();
    }

    const rawHost = c.req.header('host');
    if (rawHost !== undefined) {
      const host = parseHostHeader(rawHost);
      const allowed =
        host !== undefined &&
        ((host.hostname === publicHost.hostname && host.port === publicHost.port) ||
          (isLoopbackHost(host.hostname.replace(/^\[|\]$/g, '')) && host.port === instancePort));
      if (!allowed) {
        throw new HTTPException(421, { message: 'Misdirected request: unrecognized Host' });
      }
    }

    if (!STATE_CHANGING_METHODS.has(c.req.method) || isPathExempt(path)) {
      return next();
    }

    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin.toLowerCase())) {
        throw new HTTPException(403, { message: 'Cross-origin request rejected' });
      }
      return next();
    }
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite === 'same-origin' || fetchSite === 'none' || readBearerToken(c) !== undefined) {
      return next();
    }
    throw new HTTPException(403, { message: 'Cross-origin request rejected' });
  };
}
