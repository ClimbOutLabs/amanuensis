// Which web addresses Aman's browser may be pointed at. Only http and https are allowed, and only
// to addresses off this computer and off private networks, so a page or a tool call cannot turn the
// browser against the router, the Compose network, or Aman itself.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { URL } from 'node:url';

/** Hostnames that always mean this computer, however DNS would resolve them. */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain']);

const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  // Documentation and benchmarking ranges, and the retired 6to4 relay: never a real public site.
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  // Azure's host service (metadata, health and DNS), reachable from inside its virtual machines.
  ['168.63.129.16', 32],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}

/**
 * IPv6 is an allow list: only global unicast (2000::/3) is public. Everything else fails closed, including
 * the forms that carry an IPv4 address (mapped, translated, compatible, NAT64), link-local and unique local.
 */
const PUBLIC_V6 = new BlockList();
PUBLIC_V6.addSubnet('2000::', 3, 'ipv6');

const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  // IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT and the like; never an ordinary site.
  ['2001::', 23],
  ['2001:db8::', 32],
  // 6to4 tunnels to an IPv4 address the prefix embeds, which may be a private one.
  ['2002::', 16],
  ['3fff::', 20],
]) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** An IPv6 literal as `URL.hostname` spells it, `[::1]`, without its brackets. */
function unbracketed(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * True for anything that is not a plain public address: loopback, link-local, RFC 1918, carrier NAT,
 * multicast, tunnel and translation prefixes, and anything that is not an IP address at all. Fails
 * closed: a value this cannot read as an address is treated as private.
 */
export function isPrivateAddress(raw) {
  const address = unbracketed(String(raw)).toLowerCase();
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  if (family === 4) {
    return BLOCKED_V4.check(address, 'ipv4');
  }
  return !PUBLIC_V6.check(address, 'ipv6') || BLOCKED_V6.check(address, 'ipv6');
}

/**
 * Every address a name resolves to, or the reason it may not be reached: a name that resolves
 * nowhere, or anywhere private, is refused as a whole. The egress proxy dials one of the returned
 * addresses itself, so what was checked is what is reached (no second lookup to rebind).
 */
export async function resolvePublic(host, deps = {}) {
  const bare = unbracketed(host);
  if (isIP(bare) !== 0) {
    return isPrivateAddress(bare) ? { ok: false, reason: 'private_network' } : { ok: true, addresses: [bare] };
  }
  const name = bare.toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost')) {
    return { ok: false, reason: 'private_network' };
  }
  const resolve = deps.resolve ?? defaultResolve;
  let addresses;
  try {
    addresses = await resolve(name);
  } catch {
    return { ok: false, reason: 'unresolved' };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }
  if (addresses.some(isPrivateAddress)) {
    return { ok: false, reason: 'private_network' };
  }
  return { ok: true, addresses };
}

async function defaultResolve(name) {
  return (await dnsLookup(name, { all: true, verbatim: true })).map(entry => entry.address);
}

/** The scheme and host a navigation target must satisfy before anything is resolved or fetched. */
export function syntacticallySafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }
  const host = unbracketed(url.hostname.toLowerCase()).replace(/\.$/, '');
  if (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')) {
    return { ok: false, reason: 'private_network' };
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    return { ok: false, reason: 'private_network' };
  }
  return { ok: true, url };
}

/**
 * Whether a URL may be navigated to: the right scheme, and a host that neither is nor resolves to a
 * private address. This is the early, readable refusal for the model; the egress proxy enforces the
 * same rule on every request the browser makes, including redirects and the page's own requests.
 */
export async function safeNavigationTarget(raw, deps = {}) {
  const syntactic = syntacticallySafeUrl(raw);
  if (!syntactic.ok) {
    return syntactic;
  }
  const resolved = await resolvePublic(syntactic.url.hostname, deps);
  return resolved.ok ? { ok: true, url: syntactic.url } : resolved;
}
