import { CALDAV_SERVER_NAME } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import { MAIL_CONNECTOR_NAME } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { McpServerManifest } from '../schemas/mcpServer';

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
 * Whether `url` is on one of the operator's first-party origins. `origins` comes from the server
 * configuration (`FIRST_PARTY_MCP_ORIGINS`) already normalized, and is matched exactly: no
 * wildcards, no suffixes, no prefixes.
 */
export function isFirstPartyOrigin({ url, origins }: { url: string; origins: readonly string[] }): boolean {
  const origin = normalizedOrigin(url);
  return origin !== undefined && origins.includes(origin);
}

/**
 * Whether the connector a save leaves behind is first-party: the server's own mark, which lets
 * its read-only, explicitly closed-world tools run without asking. Three things must all hold: the
 * save designates the connector as the memory provider, this very save passed the memory provider
 * connection check, and the connector's origin is one the operator listed in the server
 * configuration. Nothing a request carries, the URL included, can add an origin to that list, so
 * a connector added by URL is never first-party unless the operator vouched for its origin.
 *
 * Every save decides afresh, so any other save clears the mark. The mark is stored on the
 * connector record and checked against the list again each time the connector is loaded.
 *
 * A connector the server mounts itself, with no stored row, is marked where it is mounted:
 * `firstParty: true` on its tool set.
 */
export function firstPartyAfterSave({
  manifest,
  memoryProviderChecked,
  origins,
}: {
  manifest: McpServerManifest;
  memoryProviderChecked: boolean;
  origins: readonly string[];
}): boolean {
  return (
    memoryProviderChecked &&
    manifest.type === 'remote' &&
    manifest.memory_provider === true &&
    isFirstPartyOrigin({ url: manifest.url, origins })
  );
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

/**
 * Why a connector may not take the name Email or Calendar, or undefined when it may: those names belong to the
 * app's own sidecars, so another address cannot use them. The text says what to do next.
 */
export function reservedNameRefusal({
  name,
  url,
  mailUrl,
  calendarUrl,
}: {
  name: string;
  url: string;
  mailUrl: string | undefined;
  calendarUrl: string | undefined;
}): string | undefined {
  if (!isReservedConnectorName(name) || isHostSidecar({ name, url, mailUrl, calendarUrl })) {
    return undefined;
  }
  return `The name "${name}" is kept for the ${name} connector that comes with Aman. Give this connector another name. To connect your ${name === MAIL_CONNECTOR_NAME ? 'email' : 'calendar'}, use Settings.`;
}

// Compared as whole addresses, so a trailing slash or a query string is a different address and fails closed.
function sameAddress({ a, b }: { a: string; b: string }): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
