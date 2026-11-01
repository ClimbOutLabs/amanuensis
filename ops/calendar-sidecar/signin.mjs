// The one sign-in check: ask the calendar server who this login is, the way the tool server's own first
// step does. Returns one fixed word and never anything the server said, because a server's answer can
// echo the login.
import { Buffer } from 'node:buffer';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import { allowedAddresses, hostOf } from './account.mjs';

export const CHECK_TIMEOUT_MS = 20_000;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

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

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/** The address a redirect points to when it stays on the same server and port over https, else null. */
function sameServerRedirect({ response, target }) {
  const location = response.headers?.location;
  if (typeof location !== 'string') {
    return null;
  }
  try {
    const next = new URL(location, target);
    return next.protocol === 'https:' && next.origin === target.origin ? next : null;
  } catch {
    return null;
  }
}

// Google's one cross-server move: the calendar address on calendar.google.com sends the client to
// Google's CalDAV service host, apidata.googleusercontent.com, under /caldav/v2/. That move, and no
// other cross-server redirect, may be followed, and only after the new host passes the same address
// checks as the first one (see checkSignIn).
const GOOGLE_CALENDAR_HOST = 'calendar.google.com';
const GOOGLE_CALDAV_HOST = 'apidata.googleusercontent.com';
const GOOGLE_CALDAV_PATH = '/caldav/v2/';

/** The Google CalDAV address a redirect points to, when the target is Google's calendar address, else null. */
function googleCaldavRedirect({ response, target }) {
  if (target.hostname !== GOOGLE_CALENDAR_HOST) {
    return null;
  }
  const location = response.headers?.location;
  if (typeof location !== 'string') {
    return null;
  }
  try {
    const next = new URL(location, target);
    return next.protocol === 'https:' &&
      next.hostname === GOOGLE_CALDAV_HOST &&
      next.pathname.startsWith(GOOGLE_CALDAV_PATH)
      ? next
      : null;
  } catch {
    return null;
  }
}

/**
 * Words: ok (signed in), login (the server refused the login), server (the address could not be reached,
 * or answered something else), certificate (its security certificate was not accepted), redirect (it sent
 * the login to another server), blocked (not an address this service may use).
 * The connection goes only to an address that passed the address rules. One redirect to another path on the
 * same server is followed, since providers often add a trailing slash. Google's calendar address may also
 * redirect once to Google's CalDAV service host; that host is checked the same way before the login is
 * sent to it. Any other redirect is refused, so neither a changing DNS answer nor a redirect can lead the
 * login somewhere else.
 */
export async function checkSignIn(account, deps = {}) {
  const host = hostOf(account.url);
  const allowed = await allowedAddresses(host, deps);
  if (!allowed.ok) {
    return allowed.reason === 'blocked' ? 'blocked' : 'server';
  }
  const first = new URL(account.url);
  const answer = await attempt({ account, target: first, allowed, deps });
  if (answer.word !== 'redirect') {
    return answer.word;
  }
  if (answer.next === null) {
    return 'redirect';
  }
  let secondAllowed = allowed;
  if (answer.next.origin !== first.origin) {
    // The only cross-server target attempt() returns is Google's CalDAV host. Check it like the first host.
    const checked = await allowedAddresses(hostOf(answer.next.toString()), deps);
    if (!checked.ok) {
      return 'redirect';
    }
    secondAllowed = checked;
  }
  const second = await attempt({ account, target: answer.next, allowed: secondAllowed, deps });
  // A second redirect is not followed either.
  return second.word;
}

function attempt({ account, target, allowed, deps }) {
  const send = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const basic = Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64');
  return new Promise(done => {
    let finished = false;
    const finish = (word, next = null) => {
      if (!finished) {
        finished = true;
        done({ word, next });
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
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(PROPFIND_BODY),
      },
      // The connection uses the addresses just checked, not a second lookup.
      lookup: (_name, lookupOptions, callback) => {
        const entries = allowed.addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
        if (lookupOptions?.all === true) {
          callback(null, entries);
        } else {
          callback(null, entries[0].address, entries[0].family);
        }
      },
      ...(deps.tls ?? {}),
    };
    const req = send(options, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      if (status >= 200 && status < 300) {
        finish('ok');
      } else if (status === 401 || status === 403) {
        finish('login');
      } else if (REDIRECT_STATUSES.has(status)) {
        finish('redirect', sameServerRedirect({ response, target }) ?? googleCaldavRedirect({ response, target }));
      } else {
        finish('server');
      }
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish('server');
    });
    req.on('error', error => finish(CERTIFICATE_ERRORS.has(error?.code) ? 'certificate' : 'server'));
    req.end(PROPFIND_BODY);
  });
}
