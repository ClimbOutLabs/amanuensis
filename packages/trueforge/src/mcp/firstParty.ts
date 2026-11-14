import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';

/**
 * Origin (scheme, host and port) of an absolute http(s) URL as the URL standard normalizes it, so
 * letter case and default ports compare equal. Undefined for anything else, and for a URL that
 * carries credentials: an `@` in a URL is how a lookalike host passes for a trusted one.
 */
export function normalizedOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  return parsed.origin;
}

/**
 * Whether `url` is on one of the host's first-party origins. `origins` comes from the server
 * configuration already normalized, and is matched exactly: no wildcards, no suffixes, no prefixes.
 */
export function isFirstPartyOrigin({ url, origins }: { url: string; origins: readonly string[] }): boolean {
  const origin = normalizedOrigin(url);
  return origin !== undefined && origins.includes(origin);
}

/**
 * Whether a stored connector is the host's own Email or Calendar sidecar. Trust follows the address
 * the host configured for that sidecar, never the name alone: a connector someone names "Email" at any
 * other address is just a connector. An import or a Settings save can leave such a record without its
 * mark, so the mark alone is not what decides.
 */
export function isHostSidecar({
  name,
  url,
  mailUrl,
  calendarUrl,
}: {
  name: string;
  url: string;
  mailUrl: string | undefined;
  calendarUrl: string | undefined;
}): boolean {
  const hostUrl = name === MAIL_CONNECTOR_NAME ? mailUrl : name === CALDAV_SERVER_NAME ? calendarUrl : undefined;
  return hostUrl !== undefined && sameAddress({ a: url, b: hostUrl });
}

/** Names the app keeps for its own Email and Calendar connectors. */
export function isReservedConnectorName(name: string): boolean {
  return name === MAIL_CONNECTOR_NAME || name === CALDAV_SERVER_NAME;
}

// Compared as whole addresses, so a trailing slash or a query string is a different address and fails closed.
function sameAddress({ a, b }: { a: string; b: string }): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
