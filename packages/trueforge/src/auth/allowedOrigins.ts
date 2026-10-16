import type { Context } from 'hono';

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** Host and port of a Host header (the port as written, empty when absent), or undefined when it is not a bare `host[:port]`. */
export function parseHostHeader(raw: string): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(`http://${raw}`);
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined;
    }
    const written = /:(\d+)$/.exec(raw)?.[1];
    return { hostname: url.hostname, port: written === undefined ? '' : String(Number(written)) };
  } catch {
    return undefined;
  }
}

/** Same name, and the same port once each side's default is filled in for the URL's scheme: `:80` is only ever http. */
export function hostMatchesUrl({ host, url }: { host: { hostname: string; port: string }; url: URL }): boolean {
  const fallback = DEFAULT_PORTS[url.protocol] ?? '';
  return (
    host.hostname === url.hostname &&
    (host.port === '' ? fallback : host.port) === (url.port === '' ? fallback : url.port)
  );
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
  return allowedOrigins.find(origin => hostMatchesUrl({ host, url: new URL(origin) }));
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

/** Shown in place of a page when a request names an address the instance was not set up for. */
export const ADDRESS_NOT_LISTED_MESSAGE =
  "This address is not one Aman is set up for. If this computer's address changed, run this on the computer that runs Aman: aman doctor network --fix";

/** Raised when a request names an address the instance was not set up for. */
export class OriginNotAllowedError extends Error {}
