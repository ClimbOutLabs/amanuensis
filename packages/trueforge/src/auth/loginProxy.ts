import type { Context, Handler } from 'hono';

const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent'];
const RETURNED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-language'];
const METHODS_WITH_BODY = new Set(['POST']);
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Passes the sign-in service through under the app's own address, so a browser on any listed address reaches it
 * without a second open port. It only talks to the issuer's origin and only to paths under the issuer's path; no
 * cookie goes either way and no credential is read here: the service does all of that.
 */
export function createLoginProxy({ issuerUrl }: { issuerUrl: string }): Handler {
  const issuer = new URL(issuerUrl);
  const prefix = issuer.pathname.replace(/\/$/, '');

  return async (c: Context): Promise<Response> => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return c.text('Method not allowed', 405);
    }
    const requested = new URL(c.req.url);
    const upstream = new URL(`${requested.pathname}${requested.search}`, issuer.origin);
    const underIssuerPath = upstream.pathname === prefix || upstream.pathname.startsWith(`${prefix}/`);
    // An encoded slash or backslash could be read as a path separator by the service, so it is never passed on.
    const hidesSeparator = /%2f|%5c/i.test(upstream.pathname);
    if (upstream.origin !== issuer.origin || !underIssuerPath || hidesSeparator) {
      return c.text('Not found', 404);
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
        ...(METHODS_WITH_BODY.has(method) ? { body: await c.req.arrayBuffer() } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      return c.text('The sign-in service did not answer.', 502);
    }
    const out = new Headers();
    for (const name of RETURNED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        out.set(name, value);
      }
    }
    const location = response.headers.get('location');
    if (location !== null) {
      // The service names itself by its own address; the browser must stay on the address it came to.
      out.set(
        'location',
        location.startsWith(`${issuer.origin}/`)
          ? `${new URL(c.req.url).origin}${location.slice(issuer.origin.length)}`
          : location,
      );
    }
    return new Response(method === 'HEAD' ? null : response.body, { status: response.status, headers: out });
  };
}
