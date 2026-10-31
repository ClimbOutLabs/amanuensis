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
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}

const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** True for an address on this computer or a private network: loopback, link-local, RFC 1918, etc. */
export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return family === 6 ? BLOCKED_V6.check(address, 'ipv6') : BLOCKED_V4.check(address, 'ipv4');
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
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')) {
    return { ok: false, reason: 'private_network' };
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    return { ok: false, reason: 'private_network' };
  }
  return { ok: true, url };
}

/**
 * Whether a URL may be navigated to: the right scheme, a host that is not itself a private address,
 * and (when it is a name) addresses that do not resolve into one either. A name that cannot be looked
 * up at all is refused, the same as one that resolves somewhere private: a browser that cannot tell
 * where a page goes must not be pointed at it.
 */
export async function safeNavigationTarget(raw, deps = {}) {
  const syntactic = syntacticallySafeUrl(raw);
  if (!syntactic.ok) {
    return syntactic;
  }
  const { url } = syntactic;
  if (isIP(url.hostname) !== 0) {
    return { ok: true, url };
  }
  const resolve = deps.resolve ?? (async name => (await dnsLookup(name, { all: true })).map(entry => entry.address));
  let addresses;
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return { ok: false, reason: 'unresolved' };
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false, reason: 'private_network' };
  }
  return { ok: true, url };
}
