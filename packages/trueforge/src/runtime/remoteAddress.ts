import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * The address check every address the person supplies for something the server connects to has
 * to pass: remote MCP servers and model base URLs, checked when the address is saved and again
 * when a connection is made. It is the calendar connector's rule (ops/calendar-sidecar's
 * account.mjs), ported here so the app and the sidecar refuse the same addresses: the host is
 * resolved, and the address is refused when any address it resolves to is loopback, link-local,
 * a cloud metadata address, another always-refused range, or one of this instance's own
 * addresses. Everything else is allowed, home-network addresses included.
 *
 * A host that does not resolve is reported as 'unresolved', apart from the refused classes.
 * Saving leaves it to the connection attempt, which fails on its own, and the host is judged
 * again on the next check if the name starts resolving. Using refuses it: a name that cannot
 * be resolved cannot be checked, and the answers a name gives can change between a check that
 * failed to resolve it and the dial that follows. (The calendar agent refuses an unresolvable
 * address at save time because its save is an unattended installer step; the app's saves are
 * interactive and report the failed connection at use.)
 *
 * Two deliberate differences from the sidecar. An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is
 * judged by the IPv4 address inside it, the same unwrapping the maps address rule does, so the
 * mapped spelling cannot slip a refused IPv4 address past the IPv6 list. And the sidecar, which
 * always runs in a container, refuses every address on its own networks from the addresses of
 * its own interfaces, while the app learns its container networks from a setting instead: the
 * installer writes the ranges Docker gave the instance's networks into
 * `CONTAINER_NETWORK_RANGES` (see config.ts), and main.ts hands them to this check through
 * configureRemoteAddressCheck. A container install therefore refuses its whole container
 * networks, whose other members are the app's own parts (its connectors among them), exactly
 * as the sidecar does. An app run directly on the host has no such setting and refuses only
 * its own addresses: the network it sits on is the person's home network, whose other
 * addresses are theirs to use.
 *
 * The check judges the addresses a host resolves to at the moment it runs. It does not pin the
 * connection that follows to those addresses; the MCP transports and the model client own their
 * sockets and take no pinning hook, so a name whose answers change between the check and the
 * connect is caught on the next check, not mid-flight.
 */

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

export interface RemoteAddressDeps {
  /** Resolves a host name to every address it answers with. Tests inject a fake. */
  resolveAddresses?: ResolveAddresses | undefined;
  /**
   * This instance's own addresses, the address of each of its network interfaces. Tests inject
   * a fake set; the default reads the machine's own network interfaces.
   */
  ownAddresses?: readonly string[] | undefined;
  /**
   * CIDR ranges of this instance's own container networks, refused as well as its own
   * addresses. Tests inject a fake set; the default is the set main.ts configured from the
   * `CONTAINER_NETWORK_RANGES` setting, which the installer writes for a container install and
   * a host run leaves empty.
   */
  ownNetworkRanges?: readonly string[] | undefined;
}

/** The container network ranges main.ts configured from the server settings, if any. */
let configuredOwnNetworkRanges: readonly string[] = [];

/** Hands the check the container network ranges from the server settings (see config.ts). */
export function configureRemoteAddressCheck(config: { ownNetworkRanges: readonly string[] }): void {
  configuredOwnNetworkRanges = config.ownNetworkRanges;
}

const ALWAYS_BLOCKED = ((): BlockList => {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], // "this network": 0.0.0.1 reaches loopback services on Linux
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local, including the cloud metadata address
    ['192.0.0.0', 24], // IETF special registry, benchmarking and documentation ranges aside
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, including the limited broadcast
    ['100.100.100.200', 32], // Alibaba Cloud metadata, inside the shared range the RFC allows
    ['168.63.129.16', 32], // Azure's virtualized host address
  ] as const) {
    blocked.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 96], // the IPv4-compatible space, ::1 loopback included
    ['64:ff9b::', 96], // NAT64 well-known prefix: the IPv4 space through a translator
    ['100::', 64], // discard-only
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
    ['fd00:ec2::254', 128], // the EC2 IPv6 metadata address
  ] as const) {
    blocked.addSubnet(network, prefix, 'ipv6');
  }
  return blocked;
})();

/** The address of every network interface on this machine: this instance's own addresses. */
export function ownInterfaceAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push(entry.address);
    }
  }
  return addresses;
}

/**
 * The addresses this check refuses because they are this instance's own: its own addresses,
 * plus every address in one of its container network ranges when ranges are in force. A range
 * that does not parse is skipped here; the settings parser refuses it at startup, so a range
 * that reaches this list has already been judged there.
 */
function ownAddressList(deps: RemoteAddressDeps): BlockList {
  const own = new BlockList();
  for (const address of deps.ownAddresses ?? ownInterfaceAddresses()) {
    const family = isIP(address);
    if (family !== 0) {
      own.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
    }
  }
  for (const range of deps.ownNetworkRanges ?? configuredOwnNetworkRanges) {
    const slash = range.lastIndexOf('/');
    if (slash < 1) {
      continue;
    }
    const network = range.slice(0, slash);
    const family = isIP(network);
    const prefix = Number(range.slice(slash + 1));
    if (family !== 0 && Number.isInteger(prefix)) {
      own.addSubnet(network, prefix, family === 6 ? 'ipv6' : 'ipv4');
    }
  }
  return own;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, or undefined when the address is not one. */
function ipv4OfMapped(address: string): string | undefined {
  if (isIP(address) !== 6) {
    return undefined;
  }
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) {
    return undefined;
  }
  const rest = lower.slice('::ffff:'.length);
  if (isIP(rest) === 4) {
    return rest;
  }
  const hextets = rest.split(':');
  if (hextets.length === 2) {
    const high = Number.parseInt(hextets[0] ?? '', 16);
    const low = Number.parseInt(hextets[1] ?? '', 16);
    if (Number.isInteger(high) && Number.isInteger(low) && high >= 0 && low >= 0) {
      return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
    }
  }
  return undefined;
}

function addressAllowed(address: string, own: BlockList): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  const kind = family === 6 ? 'ipv6' : 'ipv4';
  if (ALWAYS_BLOCKED.check(address, kind) || own.check(address, kind)) {
    return false;
  }
  const mapped = ipv4OfMapped(address);
  if (mapped !== undefined && (ALWAYS_BLOCKED.check(mapped, 'ipv4') || own.check(mapped, 'ipv4'))) {
    return false;
  }
  return true;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

export type RemoteAddressVerdict = { ok: true; addresses: string[] } | { ok: false; reason: 'blocked' | 'unresolved' };

/**
 * Judge one host the way the calendar connector's save does: an address literal is judged as it
 * stands, a name by every address it resolves to. Blocked wins over unresolved, because a host
 * that answers with even one refused address is refused outright.
 */
export async function allowedRemoteAddresses({
  host,
  deps = {},
}: {
  host: string;
  deps?: RemoteAddressDeps | undefined;
}): Promise<RemoteAddressVerdict> {
  const own = ownAddressList(deps);
  if (isIP(host) !== 0) {
    return addressAllowed(host, own) ? { ok: true, addresses: [host] } : { ok: false, reason: 'blocked' };
  }
  const resolve = deps.resolveAddresses ?? defaultResolveAddresses;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }
  return addresses.every(address => addressAllowed(address, own))
    ? { ok: true, addresses }
    : { ok: false, reason: 'blocked' };
}

export type RemoteUrlProblem = 'blocked' | 'unresolved' | 'invalid';

/**
 * The problem with a full URL whose host must pass the address check, or null when the URL may
 * be connected to. A URL is 'invalid' when it is not an http(s) address at a named host without
 * credentials in it; the shape rules are the maps address rule's, so an address the maps rule
 * refuses for its shape is refused here too.
 */
export async function remoteUrlProblem({
  url,
  deps = {},
}: {
  url: string;
  deps?: RemoteAddressDeps | undefined;
}): Promise<RemoteUrlProblem | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'invalid';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'invalid';
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (host === '') {
    return 'invalid';
  }
  const verdict = await allowedRemoteAddresses({ host, deps });
  return verdict.ok ? null : verdict.reason;
}

/**
 * The exact host:port a URL names, normalized the way a `LOCAL_MODEL_ENDPOINTS` entry is, or
 * null when the URL is not an http(s) address at a named host. The effective port counts: an
 * address that leaves the port out names the scheme's default port.
 */
export function localModelEndpointOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  return `${parsed.hostname.toLowerCase()}:${port}`;
}

/** Whether the URL names one of the exact model endpoints the operator listed. */
export function isNamedLocalModelEndpoint({ url, endpoints }: { url: string; endpoints: readonly string[] }): boolean {
  const endpoint = localModelEndpointOf(url);
  return endpoint !== null && endpoints.includes(endpoint);
}

/**
 * The problem with a model base URL, or null when the URL may be used: the address check, with
 * the one exception of an exact endpoint the operator named in `LOCAL_MODEL_ENDPOINTS`. Every
 * place a model address is judged (saving, resolving for use, and following a redirect the
 * provider answers with) goes through this one rule.
 */
export async function modelUrlProblem({
  url,
  endpoints,
  deps = {},
}: {
  url: string;
  endpoints: readonly string[];
  deps?: RemoteAddressDeps | undefined;
}): Promise<RemoteUrlProblem | null> {
  if (isNamedLocalModelEndpoint({ url, endpoints })) {
    return null;
  }
  return remoteUrlProblem({ url, deps });
}
