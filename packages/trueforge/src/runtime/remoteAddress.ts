import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * The address check for everything the server connects to at an address: remote MCP servers,
 * model base URLs, and the addresses those servers hand back (redirects, sign-in endpoints). The
 * host is resolved, and every address it resolves to is judged; a host that answers with even one
 * refused address is refused.
 *
 * Who chose the address decides how strict the check is:
 * - An address a remote server chose (a redirect, an address a sign-in service names) is refused
 *   when it is on this computer (loopback or one of this machine's own addresses), on Aman's own
 *   container networks, or a protected address (link-local, cloud metadata and the other
 *   always-refused ranges). A remote server must never steer Aman inward.
 * - An address the instance's owner chose (a connector or model saved in Settings, or set by the
 *   operator) may be on this computer when Aman runs directly on it: that computer is the owner's,
 *   and so are its services. Protected addresses stay refused. When Aman runs in a container,
 *   loopback and the container's own addresses are Aman itself, and the container networks hold
 *   Aman's own parts, so those stay refused too; a service on the owner's computer is reached at
 *   host.docker.internal, which is neither. A demo instance is used by visitors, not its owner,
 *   so it judges every address the strict way.
 *
 * The installer writes the ranges Docker gave a container instance's networks into
 * `CONTAINER_NETWORK_RANGES` (see config.ts), and main.ts hands them here through
 * configureRemoteAddressCheck; a direct run names none. An IPv4-mapped IPv6 address
 * (::ffff:127.0.0.1) is judged by the IPv4 address inside it, so the mapped spelling cannot slip
 * past the IPv4 lists. The calendar sidecar's account agent applies the strict rule to the
 * addresses it is given.
 *
 * A host that does not resolve is reported as 'unresolved'. Saving leaves it to the connection
 * attempt, and the host is judged again on the next check; using refuses it, because a name that
 * cannot be resolved cannot be checked. The check judges the addresses a host resolves to when it
 * runs and does not pin the connection that follows: the MCP transports and the model client own
 * their sockets, so a name whose answers change between the check and the connect is caught on
 * the next check, not mid-flight.
 */

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

export interface RemoteAddressDeps {
  /** Resolves a host name to every address it answers with. Tests inject a fake. */
  resolveAddresses?: ResolveAddresses | undefined;
  /** This machine's own addresses. Tests inject a fake set; the default reads the network interfaces. */
  ownAddresses?: readonly string[] | undefined;
  /**
   * CIDR ranges of the instance's container networks. Tests inject a fake set; the default is
   * what main.ts configured from `CONTAINER_NETWORK_RANGES`, empty when Aman runs directly.
   */
  ownNetworkRanges?: readonly string[] | undefined;
  /** Whether this is a demo instance. Tests inject it; the default is what main.ts configured. */
  demo?: boolean | undefined;
}

/** Who chose an address, which decides how strictly it is judged (see the module comment). */
export type AddressChooser = 'owner' | 'remote';

let configuredOwnNetworkRanges: readonly string[] = [];
let configuredDemo = false;

/** Hands the check the server settings it depends on (see config.ts). */
export function configureRemoteAddressCheck(config: { ownNetworkRanges: readonly string[]; demo: boolean }): void {
  configuredOwnNetworkRanges = config.ownNetworkRanges;
  configuredDemo = config.demo;
}

function subnetList({
  ipv4,
  ipv6,
}: {
  ipv4: readonly (readonly [string, number])[];
  ipv6: readonly (readonly [string, number])[];
}): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of ipv4) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of ipv6) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

/** Addresses that reach this computer itself whatever its network addresses are. */
const LOOPBACK = subnetList({
  ipv4: [
    ['0.0.0.0', 8], // "this network": 0.0.0.1 reaches loopback services on Linux
    ['127.0.0.0', 8],
  ],
  ipv6: [
    ['::', 128], // the unspecified address, which connects to this computer
    ['::1', 128],
  ],
});

/** Addresses no one may point Aman at: cloud metadata, link-local and other special ranges. */
const PROTECTED = subnetList({
  ipv4: [
    ['169.254.0.0', 16], // link-local, including the cloud metadata address
    ['192.0.0.0', 24], // IETF special registry, benchmarking and documentation ranges aside
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, including the limited broadcast
    ['100.100.100.200', 32], // Alibaba Cloud metadata, inside the shared range the RFC allows
    ['168.63.129.16', 32], // Azure's virtualized host address
  ],
  ipv6: [
    ['::', 96], // the IPv4-compatible space (loopback and unspecified are judged first)
    ['64:ff9b::', 96], // NAT64 well-known prefix: the IPv4 space through a translator
    ['100::', 64], // discard-only
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
    ['fd00:ec2::254', 128], // the EC2 IPv6 metadata address
  ],
});

/** The address of every network interface on this machine. */
function ownInterfaceAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push(entry.address);
    }
  }
  return addresses;
}

function addressList(addresses: readonly string[]): BlockList {
  const list = new BlockList();
  for (const address of addresses) {
    const family = isIP(address);
    if (family !== 0) {
      list.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
    }
  }
  return list;
}

/**
 * The container network ranges as one list. A range that does not parse is skipped here; the
 * settings parser refuses it at startup, so a range that reaches this list was judged there.
 */
function rangeList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const slash = range.lastIndexOf('/');
    if (slash < 1) {
      continue;
    }
    const network = range.slice(0, slash);
    const family = isIP(network);
    const prefix = Number(range.slice(slash + 1));
    if (family !== 0 && Number.isInteger(prefix)) {
      list.addSubnet(network, prefix, family === 6 ? 'ipv6' : 'ipv4');
    }
  }
  return list;
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

/** Why an address is refused: a protected address, or one inside Aman itself. */
export type RefusedAddress = 'protected' | 'internal';

interface AddressRule {
  own: BlockList;
  ranges: BlockList;
  /** Whether an address on this computer may be used: owner-chosen, run directly, not a demo. */
  thisComputerAllowed: boolean;
}

function addressRule({ chosenBy, deps }: { chosenBy: AddressChooser; deps: RemoteAddressDeps }): AddressRule {
  const ranges = deps.ownNetworkRanges ?? configuredOwnNetworkRanges;
  const demo = deps.demo ?? configuredDemo;
  return {
    own: addressList(deps.ownAddresses ?? ownInterfaceAddresses()),
    ranges: rangeList(ranges),
    thisComputerAllowed: chosenBy === 'owner' && ranges.length === 0 && !demo,
  };
}

/** Why the rule refuses an address, or null when it may be used. Something that is not an address is protected. */
function refusedAddress({ address, rule }: { address: string; rule: AddressRule }): RefusedAddress | null {
  const mapped = ipv4OfMapped(address);
  const judged = mapped ?? address;
  const family = isIP(judged);
  if (family === 0) {
    return 'protected';
  }
  const kind = family === 6 ? 'ipv6' : 'ipv4';
  const thisComputer = LOOPBACK.check(judged, kind);
  if (!thisComputer && PROTECTED.check(judged, kind)) {
    return 'protected';
  }
  if (rule.ranges.check(judged, kind)) {
    return 'internal';
  }
  if (thisComputer || rule.own.check(judged, kind)) {
    return rule.thisComputerAllowed ? null : 'internal';
  }
  return null;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

export type RemoteAddressVerdict =
  { ok: true; addresses: string[] } | { ok: false; reason: RefusedAddress | 'unresolved' };

/**
 * Judge one host: an address literal as it stands, a name by every address it resolves to. A
 * refused address wins over unresolved, and protected over internal, because a host that answers
 * with even one refused address is refused outright.
 */
export async function allowedRemoteAddresses({
  host,
  chosenBy,
  deps = {},
}: {
  host: string;
  chosenBy: AddressChooser;
  deps?: RemoteAddressDeps | undefined;
}): Promise<RemoteAddressVerdict> {
  const rule = addressRule({ chosenBy, deps });
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const resolve = deps.resolveAddresses ?? defaultResolveAddresses;
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }
  const refusals = addresses.map(address => refusedAddress({ address, rule }));
  if (refusals.includes('protected')) {
    return { ok: false, reason: 'protected' };
  }
  if (refusals.includes('internal')) {
    return { ok: false, reason: 'internal' };
  }
  return { ok: true, addresses };
}

export type RemoteUrlProblem = RefusedAddress | 'unresolved' | 'invalid';

/**
 * The problem with a full URL whose host must pass the address check, or null when the URL may
 * be connected to. A URL is 'invalid' when it is not an http(s) address at a named host without
 * credentials in it; the shape rules are the maps address rule's, so an address the maps rule
 * refuses for its shape is refused here too.
 */
export async function remoteUrlProblem({
  url,
  chosenBy,
  deps = {},
}: {
  url: string;
  chosenBy: AddressChooser;
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
  const verdict = await allowedRemoteAddresses({ host, chosenBy, deps });
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
  chosenBy,
  deps = {},
}: {
  url: string;
  endpoints: readonly string[];
  chosenBy: AddressChooser;
  deps?: RemoteAddressDeps | undefined;
}): Promise<RemoteUrlProblem | null> {
  if (isNamedLocalModelEndpoint({ url, endpoints })) {
    return null;
  }
  return remoteUrlProblem({ url, chosenBy, deps });
}
