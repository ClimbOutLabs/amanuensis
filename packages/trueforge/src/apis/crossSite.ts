/**
 * Cross-site protection for browser settings calls, shared by the settings routers that accept
 * state-changing requests from the app's own pages (Google, Email).
 */
import type { MiddlewareHandler } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import configuration, { getAllowedOrigins } from '../config';

/**
 * The addresses the installer serves this instance on, as recorded origins: the public address plus the
 * recorded origins. These are the only addresses a request may name as its own; anything else is not Aman's.
 */
function instanceOrigins(): string[] {
  const origins = [...getAllowedOrigins()];
  try {
    const publicOrigin = new URL(configuration.PUBLIC_BASE_URL).origin;
    if (!origins.includes(publicOrigin)) {
      origins.unshift(publicOrigin);
    }
  } catch {
    // No usable public address configured; the recorded origins are the whole list.
  }
  return origins;
}

/**
 * The address the browser used. A proxy in front of Aman may have rewritten it, so the forwarded host counts
 * only when it names an address the installer serves this instance on: the public address, or one of the
 * recorded origins, whose own address is then the browser's. Any other forwarded value is ignored.
 */
export function browserUrlOf(c: Parameters<ResolveRequestContext>[0]): string {
  const url = new URL(c.req.url);
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost === undefined || forwardedHost === '') {
    return url.toString();
  }
  for (const origin of getAllowedOrigins()) {
    let recorded: URL;
    try {
      recorded = new URL(origin);
    } catch {
      continue;
    }
    if (recorded.host.toLowerCase() === forwardedHost.toLowerCase()) {
      try {
        return new URL(`${url.pathname}${url.search}`, recorded.origin).toString();
      } catch {
        return url.toString();
      }
    }
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
    const allowed = new Set([new URL(browserUrlOf(c)).origin, ...instanceOrigins()]);
    if (origin !== undefined && allowed.has(origin)) {
      return next();
    }
    return c.json({ error: { message: NOT_FROM_AMAN, type: 'cross_site_request' } }, 403);
  };
}
