import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Handler } from 'hono';
import { isLoopbackHost } from '../config';
import { ADDRESS_NOT_LISTED_MESSAGE, requestAllowedOrigin } from './allowedOrigins';
import { LoginAttemptLimiter } from './loginRateLimit';

const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent'];
const RETURNED_RESPONSE_HEADERS = ['content-type', 'content-language'];
const METHODS_WITH_BODY = new Set(['POST']);
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Only what a browser needs to sign in: never the token, userinfo, key, discovery or device endpoints. */
const BROWSER_PATHS = [/^\/auth(\/.+)?$/, /^\/approval$/, /^\/callback$/, /^\/static\/.+$/, /^\/theme\/.+$/];
const PASSWORD_POST_PATH = /^\/auth\/[^/]+\/login$/;
/** Each of these makes the sign-in service store a new sign-in request. */
const PAGE_START_PATH = /^\/auth(\/[^/]+)?$/;

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** The sign-in service can be passed through only when it sits on this computer and has a path of its own. */
export function isProxiableIssuer(issuerUrl: string): boolean {
  try {
    const issuer = new URL(issuerUrl);
    return issuer.protocol === 'http:' && isLoopbackHost(issuer.hostname) && issuer.pathname.replace(/\/$/, '') !== '';
  } catch {
    return false;
  }
}

/**
 * The address a request came from. Behind a reverse proxy on this computer the connection is a loopback one, or one
 * from the address of the proxy's network (a published port reaches the app from the Docker bridge); then the address
 * that proxy recorded last is taken instead. A header from any other connection is never read.
 */
function clientKeyFor(trustedProxies: readonly string[]): (c: Context) => string {
  return c => {
    let remote = 'unknown';
    try {
      remote = (getConnInfo(c).remote.address ?? 'unknown').replace(/^::ffff:/, '');
    } catch {
      return remote;
    }
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if ((isLoopbackHost(remote) || trustedProxies.includes(remote)) && forwarded !== undefined && forwarded !== '') {
      return forwarded;
    }
    return remote;
  };
}

/** The account a password post is for, as the sign-in form names it. */
function accountOf(body: ArrayBuffer): string {
  return new URLSearchParams(new TextDecoder().decode(body)).get('login') ?? '';
}

/**
 * Passes the sign-in pages through under the app's own address, so a browser on any listed address reaches them without
 * a second open port. It talks only to the sign-in service's own origin, only to the browser paths under its path, and
 * sends no cookie either way. Password posts are rate limited by client address.
 */
export function createLoginProxy({
  issuerUrl,
  upstreamUrl = issuerUrl,
  allowedOrigins,
  limiter = new LoginAttemptLimiter(),
  trustedProxies = [],
  clientKey = clientKeyFor(trustedProxies),
}: {
  issuerUrl: string;
  /** Where the sign-in service is reached when that differs from the address browsers know it by. */
  upstreamUrl?: string;
  allowedOrigins: readonly string[];
  limiter?: LoginAttemptLimiter;
  /** Addresses of a reverse proxy whose X-Forwarded-For is believed, besides this computer's own. */
  trustedProxies?: readonly string[];
  clientKey?: (c: Context) => string;
}): Handler {
  if (!isProxiableIssuer(upstreamUrl)) {
    throw new Error('The sign-in service can be passed through only when it is on a loopback host with a path');
  }
  const service = new URL(upstreamUrl);
  const ownNames = [service.origin, new URL(issuerUrl).origin];
  const prefix = service.pathname.replace(/\/$/, '');
  if (new URL(issuerUrl).pathname.replace(/\/$/, '') !== prefix) {
    throw new Error('The sign-in service must have the same path where it runs and where browsers find it');
  }

  const tooMany = (retryAfterSeconds: number): Response =>
    new Response(`Too many sign-in attempts. Wait ${String(retryAfterSeconds)} seconds and try again.`, {
      status: 429,
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'retry-after': String(retryAfterSeconds),
        ...SECURITY_HEADERS,
      },
    });

  return async (c: Context): Promise<Response> => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return c.text('Method not allowed', 405);
    }
    const matchedOrigin = requestAllowedOrigin({ context: c, allowedOrigins });
    if (matchedOrigin === undefined) {
      return c.text(ADDRESS_NOT_LISTED_MESSAGE, 421);
    }
    const requested = new URL(c.req.url);
    const upstream = new URL(`${requested.pathname}${requested.search}`, service.origin);
    // An encoded slash or backslash could be read as a path separator by the service, so it is never passed on.
    const hidesSeparator = /%2f|%5c/i.test(upstream.pathname);
    const sub = upstream.pathname.startsWith(`${prefix}/`) ? upstream.pathname.slice(prefix.length) : '';
    if (upstream.origin !== service.origin || hidesSeparator || !BROWSER_PATHS.some(path => path.test(sub))) {
      return c.text('Not found', 404);
    }
    const guessing = method === 'POST' && PASSWORD_POST_PATH.test(sub);
    const key = guessing || (method === 'GET' && PAGE_START_PATH.test(sub)) ? clientKey(c) : '';
    if (key !== '' && !guessing) {
      const page = limiter.allowPageStart(key);
      if (!page.allowed) {
        return tooMany(page.retryAfterSeconds);
      }
    }
    let body: ArrayBuffer | undefined;
    if (METHODS_WITH_BODY.has(method)) {
      try {
        body = await c.req.arrayBuffer();
      } catch {
        return c.text('The request could not be read.', 400);
      }
    }
    const permit = guessing && body !== undefined ? limiter.begin(key, accountOf(body)) : undefined;
    if (permit !== undefined && !permit.allowed) {
      return tooMany(permit.retryAfterSeconds);
    }
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) {
        headers.set(name, value);
      }
    }
    let response: Response;
    try {
      response = await fetch(upstream, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      permit?.finish('abandon');
      return c.text('The sign-in service did not answer.', 502);
    }
    // A redirect means the password was accepted; the form shown again means it was not.
    permit?.finish(response.status >= 300 && response.status < 400 ? 'success' : 'failure');
    const out = new Headers(SECURITY_HEADERS);
    for (const name of RETURNED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        out.set(name, value);
      }
    }
    const location = response.headers.get('location');
    if (location !== null) {
      // The service names itself by its own address; the browser stays on the listed address it came to.
      const own = ownNames.find(name => location.startsWith(`${name}/`));
      out.set('location', own === undefined ? location : `${matchedOrigin}${location.slice(own.length)}`);
    }
    return new Response(method === 'HEAD' ? null : response.body, { status: response.status, headers: out });
  };
}
