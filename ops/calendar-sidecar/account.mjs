// The saved calendar account and the rules for the address it signs in to.
// The account file holds the four settings the CalDAV tool server reads, in the format the installer
// has always written. This module is the one owner of that format and of the address rules.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { URL } from 'node:url';

export const ACCOUNT_FILE_HEADER =
  '# Written by the installer for the Calendar connector. Keep it private: it holds the app password.';

// What the file can hold without a value being able to start a new line or a new setting.
// The installer and the Settings card check the address and the login name the same way first and word
// the problem for a person; the agent applies the rules again before it saves anything.
const URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/@%+=,:-]*)?$/;
const USER_PATTERN = /^[A-Za-z0-9._+@=-]+$/;
// Any printable character, spaces inside included, but nothing that could end the line or start a new setting.
// This is the one place that decides which characters a password may hold; the app and the installer only
// check that one was typed, and ask the agent.
const PASSWORD_PATTERN = /^[^\p{C}\p{Zl}\p{Zp}]+$/u;
// Dot-separated names whose parts start and end with a letter or digit, or an IPv4 address.
const HOST_PATTERN = /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.?$/;
// Printable ASCII only: the tool server puts the address in a header and a search, where anything else breaks it.
const EMAIL_PATTERN = /^[\x21-\x3F\x41-\x7E]+@[\x21-\x3F\x41-\x7E]+\.[\x21-\x3F\x41-\x7E]+$/;

export const MAX_FIELD_LENGTH = 512;

function withinLimits(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/** The first field the account file cannot hold safely, or null when every field is fine. */
export function accountProblem(account) {
  if (account === null || typeof account !== 'object') {
    return 'url';
  }
  if (!withinLimits(account.url) || !addressIsWellFormed(account.url)) {
    return 'url';
  }
  if (!withinLimits(account.username) || !USER_PATTERN.test(account.username)) {
    return 'username';
  }
  const passwordFits = withinLimits(account.password) && PASSWORD_PATTERN.test(account.password);
  if (!passwordFits || account.password !== account.password.trim()) {
    return 'password';
  }
  if (!withinLimits(account.email) || !EMAIL_PATTERN.test(account.email)) {
    return 'email';
  }
  return null;
}

/** True when every field is something the account file can hold safely. */
export function accountIsWellFormed(account) {
  return accountProblem(account) === null;
}

// The host must read the same after the URL parser normalizes it. A host written as a number in a
// disguised form (such as 0x7f.1 for 127.0.0.1) changes in the parser, so it is refused here instead of
// being judged by one reader and used by another.
function addressIsWellFormed(address) {
  if (!URL_PATTERN.test(address)) {
    return false;
  }
  const hostPart = address.slice('https://'.length).split('/')[0];
  if (hostPart.includes('@')) {
    return false;
  }
  try {
    const parsed = new URL(address);
    return (
      parsed.protocol === 'https:' &&
      HOST_PATTERN.test(parsed.hostname) &&
      parsed.hostname === hostPart.split(':')[0].toLowerCase()
    );
  } catch {
    return false;
  }
}

/** The host of a well-formed address, in lower case. */
export function hostOf(url) {
  return new URL(url).hostname.toLowerCase();
}

export function renderAccount(account) {
  return (
    [
      ACCOUNT_FILE_HEADER,
      `CALDAV_URL=${account.url}`,
      `CALDAV_USERNAME=${account.username}`,
      `CALDAV_PASSWORD=${account.password}`,
      `CALDAV_USER_EMAIL=${account.email}`,
    ].join('\n') + '\n'
  );
}

/** The account in a file's text, or null when no complete, well-formed account is there. */
export function parseAccount(text) {
  const values = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const account = {
    url: values.get('CALDAV_URL') ?? '',
    username: values.get('CALDAV_USERNAME') ?? '',
    password: values.get('CALDAV_PASSWORD') ?? '',
    email: values.get('CALDAV_USER_EMAIL') ?? '',
  };
  return accountIsWellFormed(account) ? account : null;
}

/** The account as responses may carry it: everything but the password. */
export function publicAccount(account) {
  return { url: account.url, username: account.username, email: account.email };
}

// Addresses the calendar address may never resolve to. Everything not listed here is allowed: the
// internet, and servers on a home or office network (10.x, 172.16.x, 192.168.x, 100.64.x, fc00::/7).
const ALWAYS_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // this computer, "any"
  ['127.0.0.0', 8], // this computer
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['192.0.0.0', 24], // protocol assignments, including a cloud metadata address
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
  ['100.100.100.200', 32], // a cloud metadata address inside the shared 100.64.0.0/10 range
  ['168.63.129.16', 32], // a cloud host's private service address
]) {
  ALWAYS_BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the old IPv4-compatible range
  ['64:ff9b::', 96], // IPv4 translation range
  ['100::', 64], // discard-only
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['fd00:ec2::254', 128], // a cloud metadata address
]) {
  ALWAYS_BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** The networks this container is attached to. Their other members are Aman's own parts. */
export function ownNetworks(interfaces = networkInterfaces()) {
  const own = new BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const prefix = Number(entry.cidr?.split('/')[1]);
      if (Number.isInteger(prefix)) {
        own.addSubnet(entry.address, prefix, entry.family === 'IPv6' || entry.family === 6 ? 'ipv6' : 'ipv4');
      }
    }
  }
  return own;
}

export function addressAllowed(address, own) {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  const kind = family === 6 ? 'ipv6' : 'ipv4';
  return !ALWAYS_BLOCKED.check(address, kind) && !own.check(address, kind);
}

/**
 * Looks the host up and returns its addresses, or says why it may not be used. One refused address
 * refuses the host, so a name that also points somewhere forbidden cannot be used.
 */
export async function allowedAddresses(host, deps = {}) {
  const resolve = deps.resolve ?? (async name => (await dnsLookup(name, { all: true })).map(entry => entry.address));
  const own = deps.ownNetworks ?? ownNetworks();
  let addresses;
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, reason: 'unresolved' };
    }
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }
  if (!addresses.every(address => addressAllowed(address, own))) {
    return { ok: false, reason: 'blocked' };
  }
  return { ok: true, addresses };
}
