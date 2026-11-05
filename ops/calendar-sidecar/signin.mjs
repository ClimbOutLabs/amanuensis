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
 * Words: ok (signed in), login (the server refused the login), server (the address could not be reached,
 * or answered something else), certificate (its security certificate was not accepted), redirect (it sent
 * the login to another address), blocked (not an address this service may use).
 * The connection goes only to an address that passed the address rules. No redirect is followed: the tool
 * server refuses every redirect, so an address that redirects would pass here and then fail on every
 * calendar call.
 */
export async function checkSignIn(account, deps = {}) {
  const host = hostOf(account.url);
  const allowed = await allowedAddresses(host, deps);
  if (!allowed.ok) {
    return allowed.reason === 'blocked' ? 'blocked' : 'server';
  }
  return attempt({ account, target: firstRequestUrl(account.url), allowed, deps });
}

function attempt({ account, target, allowed, deps }) {
  const send = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const basic = Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64');
  return new Promise(done => {
    let finished = false;
    const finish = word => {
      if (!finished) {
        finished = true;
        done(word);
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
        finish('redirect');
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
