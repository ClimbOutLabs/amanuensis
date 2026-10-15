import type { Context } from 'hono';

/** Default ports are dropped so `example.com` and `example.com:443` compare equal. */
export function canonicalPort(port: string): string {
  return port === '80' || port === '443' ? '' : port;
}

/** Host and port of a Host header, or undefined when it is not a bare `host[:port]`. */
export function parseHostHeader(raw: string): { hostname: string; port: string } | undefined {
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

/**
 * The listed origin a Host header names, or undefined. The result is always one of the listed strings, never text
 * taken from the request, so nothing a client sends can make sign-in return to an address that is not listed.
 */
export function findAllowedOrigin({
  hostHeader,
  allowedOrigins,
}: {
  hostHeader: string | undefined;
  allowedOrigins: readonly string[];
}): string | undefined {
  if (hostHeader === undefined) {
    return undefined;
  }
  const host = parseHostHeader(hostHeader);
  if (host === undefined) {
    return undefined;
  }
  return allowedOrigins.find(origin => {
    const listed = new URL(origin);
    return listed.hostname === host.hostname && canonicalPort(listed.port) === host.port;
  });
}

/** The listed origin this request came to. Forwarded-* headers are never read. */
export function requestAllowedOrigin({
  context,
  allowedOrigins,
}: {
  context: Context;
  allowedOrigins: readonly string[];
}): string | undefined {
  return findAllowedOrigin({ hostHeader: context.req.header('host'), allowedOrigins });
}

/** Raised when a request names an address the instance was not set up for. */
export class OriginNotAllowedError extends Error {}
