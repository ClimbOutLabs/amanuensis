// The one sign-in check, and the address the tool server is started on. It walks the same first steps the
// tool server's own discovery takes (the saved address, the principal, the calendar home set), reads every answer with the tool server's own XML reader, and returns one fixed word and never
// anything the server said, because a server's answer can echo the login.
//
// Every host this walk connects to passes the address rules first, and the connection uses the addresses
// that were checked. A calendar home on another host (iCloud keeps it on pNN-caldav.icloud.com) is not
// trusted because the server named it: it passes the same rules, and the walk is run again from it, since
// the tool server only ever talks to the one host it is started on.
import { Buffer } from 'node:buffer';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import { hrefsOf, parseMultiStatus, propfindBody, resourceTypeHas } from '@ni-c/caldav-mcp/dist/dav-xml.js';

import { addressIsWellFormed, allowedAddresses, hostOf } from './account.mjs';

export const CHECK_TIMEOUT_MS = 20_000;

// The properties the tool server asks for at each step, so a server answers this walk as it answers the tools.
const HOME_PROPS = ['D:resourcetype', 'D:current-user-principal', 'C:calendar-home-set'];
const PRINCIPAL_PROPS = ['C:calendar-home-set', 'C:calendar-user-address-set'];

// The tool server's own ceilings: it uses at most eight home sets, reads at most 16 MB of one answer and
// follows no link longer than 8 KB.
const MAX_HOMES = 8;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_HREF_CHARS = 8 * 1024;

// TLS failures that mean the server's certificate is not one this service trusts.
const CERTIFICATE_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The address the tool server sends its first request to: the saved address without its query and with one
 * trailing slash. The check asks that same address so a pass here means the tool server's first step passes.
 */
export function firstRequestUrl(url) {
  const parsed = new URL(url);
  return new URL(`${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/`);
}

/**
 * Words: ok (signed in), login (the server refused the login), server (an address
 * could not be reached, or answered something the tool server cannot use), certificate (a security
 * certificate was not accepted), redirect (the saved address sends the login to another address), blocked
 * (an address this service may not use).
 * No redirect is followed: the tool server refuses every redirect, so an address that redirects would pass
 * here and then fail on every calendar call.
 */
export async function checkSignIn(account, deps = {}) {
  return (await discoverCalendarServer(account, deps)).result;
}

/**
 * The walk itself. On success it also returns `server_url`, the address the tool server is started on: the
 * saved address when everything sits on its host, or the calendar home set when that lives on another host.
 */
export async function discoverCalendarServer(account, deps = {}) {
  const session = { account, deps, hosts: new Map() };
  const first = await walk({ session, start: account.url });
  if (first.result !== 'elsewhere') {
    return first;
  }
  // Everything the account points at lives on one other host. The tool server is started there, so the walk
  // is run once more from that address exactly as the tool server will run it, and must stay on that host.
  const second = await walk({ session, start: first.next });
  return second.result === 'elsewhere' ? { result: 'server' } : second;
}

async function walk({ session, start }) {
  if (!addressIsWellFormed(start)) {
    return { result: 'server' };
  }
  const root = firstRequestUrl(start).toString();
  const asked = await propfind({ session, url: root, depth: 0, props: HOME_PROPS });
  if (asked.result !== 'ok') {
    return asked;
  }
  const self = asked.responses[0];
  const principalHref = hrefsOf(self?.props['current-user-principal'])[0];
  if (principalHref === undefined || resourceTypeHas(self?.props.resourcetype, 'calendar')) {
    // One calendar, or no principal named: the tool server stays on this address either way.
    return { result: 'ok', server_url: start };
  }
  const principalUrl = resolveHref({ href: principalHref, base: root });
  if (principalUrl === null) {
    return { result: 'server' };
  }
  const onPrincipal = await propfind({ session, url: principalUrl, depth: 0, props: PRINCIPAL_PROPS });
  if (onPrincipal.result !== 'ok') {
    return onPrincipal;
  }
  const homes = hrefsOf(onPrincipal.responses[0]?.props['calendar-home-set'])
    .slice(0, MAX_HOMES)
    .map(href => resolveHref({ href, base: principalUrl }));
  if (homes.some(home => home === null)) {
    return { result: 'server' };
  }
  const origin = originOf(root);
  if ([principalUrl, ...homes].every(url => originOf(url) === origin)) {
    return { result: 'ok', server_url: start };
  }
  // The tool server talks to one host only, so every home set must sit on the same other host.
  if (homes.length === 0 || new Set(homes.map(originOf)).size !== 1) {
    return { result: 'server' };
  }
  const home = new URL(homes[0]);
  return { result: 'elsewhere', next: `${home.origin}${home.pathname}` };
}

function originOf(url) {
  return new URL(url).origin;
}

/** A server's link as an absolute https address with no name or password in it, or null. */
function resolveHref({ href, base }) {
  if (href.length > MAX_HREF_CHARS) {
    return null;
  }
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol !== 'https:' || resolved.username !== '' || resolved.password !== '') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/** One PROPFIND to a host that passed the address rules. Results: ok (with the parsed responses) or a failure word. */
async function propfind({ session, url, depth, props }) {
  const host = hostOf(url);
  let allowed = session.hosts.get(host);
  if (allowed === undefined) {
    allowed = await allowedAddresses(host, session.deps);
    session.hosts.set(host, allowed);
  }
  if (!allowed.ok) {
    return { result: allowed.reason === 'blocked' ? 'blocked' : 'server' };
  }
  const answer = await send({
    session,
    target: new URL(url),
    depth,
    body: propfindBody(props),
    addresses: allowed.addresses,
  });
  if (answer.result !== 'ok') {
    return answer;
  }
  const { status, text } = answer;
  if (status >= 200 && status < 300) {
    try {
      return { result: 'ok', responses: parseMultiStatus(text, 'CalDAV PROPFIND') };
    } catch {
      return { result: 'server' };
    }
  }
  if (status === 401 || status === 403) {
    return { result: 'login' };
  }
  return { result: REDIRECT_STATUSES.has(status) ? 'redirect' : 'server' };
}

function send({ session, target, depth, body, addresses }) {
  const { account, deps } = session;
  const request = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const basic = Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64');
  return new Promise(done => {
    let finished = false;
    const finish = answer => {
      if (!finished) {
        finished = true;
        done(answer);
      }
    };
    const options = {
      method: 'PROPFIND',
      protocol: 'https:',
      hostname: target.hostname,
      port: target.port === '' ? 443 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: {
        Authorization: `Basic ${basic}`,
        Depth: String(depth),
        Accept: 'application/xml, text/xml',
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
      // The connection uses the addresses just checked, not a second lookup.
      lookup: (_name, lookupOptions, callback) => {
        const entries = addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
        if (lookupOptions?.all === true) {
          callback(null, entries);
        } else {
          callback(null, entries[0].address, entries[0].family);
        }
      },
      ...(deps.tls ?? {}),
    };
    const req = request(options, response => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        finish({ result: 'ok', status, text: '' });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          finish({ result: 'server' });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish({ result: 'ok', status, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish({ result: 'server' }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ result: 'server' });
    });
    req.on('error', error => finish({ result: CERTIFICATE_ERRORS.has(error?.code) ? 'certificate' : 'server' }));
    req.end(body);
  });
}
