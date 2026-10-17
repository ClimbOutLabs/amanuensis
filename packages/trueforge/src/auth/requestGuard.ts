import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { isLoopbackHost } from '../config';
import { ADDRESS_NOT_LISTED_MESSAGE, findAllowedOrigin, hostMatchesUrl, parseHostHeader } from './allowedOrigins';
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
  /**
   * The sign-in service's public address, when the app passes its pages through: that address is served only under the
   * service's own path, and writes there need the Origin of the sign-in page itself.
   */
  loginGatewayUrl?: string;
  /** Path of the sign-in pages the app passes through when they are not on a separate address. */
  loginPath?: string;
}): MiddlewareHandler {
  const allowedOrigins = options.allowedOrigins ?? [];
  const publicUrl = new URL(options.publicBaseUrl);
  const publicIsLoopback = isLoopbackHost(publicUrl.hostname);
  const gatewayUrl = options.loginGatewayUrl === undefined ? undefined : new URL(options.loginGatewayUrl);
  const gatewayPrefix = gatewayUrl?.pathname.replace(/\/$/, '') ?? '';
  const instanceUrl = new URL(`http://localhost:${String(options.port)}`);
  const allowedOriginSet = new Set([
    publicUrl.origin,
    ...(gatewayUrl === undefined ? [] : [gatewayUrl.origin]),
    ...allowedOrigins,
    ...LOOPBACK_ORIGIN_HOSTS.map(host => `http://${host}:${String(options.port)}`),
    ...(publicIsLoopback
      ? LOOPBACK_ORIGIN_HOSTS.map(
          host => `${publicUrl.protocol}//${host}${publicUrl.port === '' ? '' : `:${publicUrl.port}`}`,
        )
      : []),
  ]);

  const loginPrefix = options.loginPath ?? gatewayPrefix;
  // The sign-in service accepts a post from anywhere, so the app insists on the sign-in page's own Origin.
  const requireLoginPageOrigin = (method: string, origin: string | undefined): void => {
    if (STATE_CHANGING_METHODS.has(method) && !allowedOriginSet.has((origin ?? '').toLowerCase())) {
      throw new HTTPException(403, { message: 'Cross-origin request rejected' });
    }
  };

  return async (c, next) => {
    const path = c.req.path;
    if (path === '/healthz') {
      return next();
    }

    const rawHost = c.req.header('host');
    if (rawHost !== undefined) {
      const host = parseHostHeader(rawHost);
      if (host !== undefined && gatewayUrl !== undefined && !hostMatchesUrl({ host, url: publicUrl })) {
        if (hostMatchesUrl({ host, url: gatewayUrl })) {
          if (path.startsWith(`${gatewayPrefix}/`)) {
            requireLoginPageOrigin(c.req.method, c.req.header('origin'));
            return next();
          }
          throw new HTTPException(421, { message: 'Misdirected request: unrecognized Host' });
        }
      }
      const allowed =
        host !== undefined &&
        (hostMatchesUrl({ host, url: publicUrl }) ||
          (isLoopbackHost(host.hostname) &&
            (hostMatchesUrl({ host: { ...host, hostname: instanceUrl.hostname }, url: instanceUrl }) ||
              (publicIsLoopback &&
                hostMatchesUrl({ host: { ...host, hostname: publicUrl.hostname }, url: publicUrl })))) ||
          findAllowedOrigin({ hostHeader: rawHost, allowedOrigins }) !== undefined);
      if (!allowed) {
        if (allowedOrigins.length > 0) {
          return c.text(ADDRESS_NOT_LISTED_MESSAGE, 421);
        }
        throw new HTTPException(421, { message: 'Misdirected request: unrecognized Host' });
      }
    }

    if (loginPrefix !== '' && path.startsWith(`${loginPrefix}/`)) {
      requireLoginPageOrigin(c.req.method, c.req.header('origin'));
      return next();
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
