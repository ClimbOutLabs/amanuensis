/**
 * Cross-site protection for browser settings calls, shared by the settings routers that accept
 * state-changing requests from the app's own pages (Google, Email).
 */
import type { MiddlewareHandler } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';

/**
 * The address the browser used. A proxy in front of Aman may have rewritten it, so the forwarded host and
 * protocol count only when the host is the public address itself; any other forwarded value is ignored.
 */
export function browserUrlOf(c: Parameters<ResolveRequestContext>[0]): string {
  const url = new URL(c.req.url);
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost === undefined || forwardedHost === '') {
    return url.toString();
  }
  let publicHost: string;
  try {
    publicHost = new URL(configuration.PUBLIC_BASE_URL).host;
  } catch {
    return url.toString();
  }
  if (forwardedHost.toLowerCase() !== publicHost.toLowerCase()) {
    return url.toString();
  }
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : url.protocol.slice(0, -1);
  try {
    return new URL(`${url.pathname}${url.search}`, `${proto}://${forwardedHost}`).toString();
  } catch {
    return url.toString();
  }
}

export const NOT_FROM_AMAN = 'That request did not come from Aman, so nothing was done.';

/**
 * Blocks a cross-site form from firing a state-changing call that has no body. A page on another site can
 * submit a form but cannot send JSON or a same-origin Origin header; Aman's own pages do at least one.
 */
export function requireJsonOrSameOrigin(): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType === 'application/json') {
      return next();
    }
    const origin = c.req.header('origin');
    const allowed = new Set([new URL(browserUrlOf(c)).origin]);
    try {
      allowed.add(new URL(configuration.PUBLIC_BASE_URL).origin);
    } catch {
      // No usable public address configured; the request's own address is the only one.
    }
    if (origin !== undefined && allowed.has(origin)) {
      return next();
    }
    return c.json({ error: { message: NOT_FROM_AMAN, type: 'cross_site_request' } }, 403);
  };
}
