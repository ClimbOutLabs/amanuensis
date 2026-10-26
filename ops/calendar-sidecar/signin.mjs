// The one sign-in check: ask the calendar server who this login is, the way the tool server's own first
// step does. Returns one fixed word and never anything the server said, because a server's answer can
// echo the login.
import { request as httpsRequest } from 'node:https';

import { allowedAddresses, hostOf } from './account.mjs';

export const CHECK_TIMEOUT_MS = 20_000;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

/**
 * Words: ok (signed in), login (the server refused the login), server (the address could not be reached
 * or trusted, answered something else, or is not an address this service may use), blocked (not allowed).
 * The connection goes only to an address that passed the address rules, and no redirect is followed,
 * so neither a changing DNS answer nor a redirect can lead the login somewhere else.
 */
export async function checkSignIn(account, deps = {}) {
  const host = hostOf(account.url);
  const allowed = await allowedAddresses(host, deps);
  if (!allowed.ok) {
    return allowed.reason === 'blocked' ? 'blocked' : 'server';
  }
  const send = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const target = new URL(account.url);
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
      } else {
        finish('server');
      }
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish('server');
    });
    req.on('error', () => finish('server'));
    req.end(PROPFIND_BODY);
  });
}
