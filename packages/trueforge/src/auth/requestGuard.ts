import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { isLoopbackHost } from '../config';
import { ADDRESS_NOT_LISTED_MESSAGE, canonicalPort, findAllowedOrigin, parseHostHeader } from './allowedOrigins';
import { readBearerToken } from './token';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_ORIGIN_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** Reachable without a browser session: probes, the service-key route, and the connector OAuth redirect. */
const ORIGIN_EXEMPT_PATHS = ['/healthz', '/api/internal/schedules', '/api/v1/mcp-servers/oauth'];

function isPathExempt(path: string): boolean {
  return ORIGIN_EXEMPT_PATHS.some(exempt => path === exempt || path.startsWith(`${exempt}/`));
}

/**
 * Standalone request guard for cookie-authenticated sessions. Forwarded-* headers are never read.
 * - Host must be a loopback name on the instance port or the public URL's host, else 421
 *   (defeats DNS rebinding). When the public URL is itself loopback, any loopback name
 *   on its port is accepted too, so `localhost` works for a `127.0.0.1` public URL. Every listed allowed origin is accepted as
 *   Host and as Origin too. A request with no Host header passes: browsers always send one.
 * - State-changing requests need a same-origin signal: an allowed Origin, else
 *   `Sec-Fetch-Site: same-origin|none`, else a Bearer header; otherwise 403.
 */
export function createRequestGuardMiddleware(options: {
  port: number;
  publicBaseUrl: string;
  /** The addresses an instance opened on the local network answers at; empty for a single public address. */
  allowedOrigins?: readonly string[];
}): MiddlewareHandler {
  const allowedOrigins = options.allowedOrigins ?? [];
  const publicUrl = new URL(options.publicBaseUrl);
  const publicHost = { hostname: publicUrl.hostname, port: canonicalPort(publicUrl.port) };
  const instancePort = canonicalPort(String(options.port));
  const publicIsLoopback = isLoopbackHost(publicUrl.hostname);
  const loopbackPorts = new Set([instancePort, ...(publicIsLoopback ? [publicHost.port] : [])]);
  const allowedOriginSet = new Set([
    publicUrl.origin,
    ...allowedOrigins,
    ...LOOPBACK_ORIGIN_HOSTS.map(host => `http://${host}:${String(options.port)}`),
    ...(publicIsLoopback
      ? LOOPBACK_ORIGIN_HOSTS.map(
          host => `${publicUrl.protocol}//${host}${publicUrl.port === '' ? '' : `:${publicUrl.port}`}`,
        )
      : []),
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
          (isLoopbackHost(host.hostname) && loopbackPorts.has(host.port)) ||
          findAllowedOrigin({ hostHeader: rawHost, allowedOrigins }) !== undefined);
      if (!allowed) {
        if (allowedOrigins.length > 0) {
          return c.text(ADDRESS_NOT_LISTED_MESSAGE, 421);
        }
        throw new HTTPException(421, { message: 'Misdirected request: unrecognized Host' });
      }
    }

    if (!STATE_CHANGING_METHODS.has(c.req.method) || isPathExempt(path)) {
      return next();
    }

    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (!allowedOriginSet.has(origin.toLowerCase())) {
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
