// Fake CalDAV hosts for the sign-in walk and the supervisor tests. Shaped like iCloud: the saved address
// names the principal on its own host, and the principal names a calendar home on a second host of the
// same provider. The second host answers for the same account on its own name.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownNetworks } from '../account.mjs';

export const BASE_HOST = 'caldav.cloud.example.invalid';
export const HOME_HOST = 'p42-caldav.cloud.example.invalid';
export const OTHER_HOST = 'p43-caldav.cloud.example.invalid';
export const PUBLIC_ADDRESS = '93.184.216.34';
export const ACCOUNT_ID = '1234567';
export const PASSWORD = 'CANARY-APP-SPECIFIC-PASSWORD';
export const USER = 'person@icloud.example.invalid';

export const multistatus = ({ href, props }) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response>' +
  `<href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat>` +
  '</response></multistatus>';
export const principalProp = href => `<current-user-principal><href>${href}</href></current-user-principal>`;
export const homeProp = (...hrefs) =>
  `<C:calendar-home-set>${hrefs.map(href => `<href>${href}</href>`).join('')}</C:calendar-home-set>`;

/**
 * A request function for the walk's `deps.request`. The fake servers listen on 127.0.0.1 behind the public
 * address the rules checked, so the connection is routed there; first it records which addresses the walk's
 * own lookup hands the connection, to prove the checked ones are used.
 */
export function routedRequest(record = () => undefined) {
  return (options, onResponse) => {
    options.lookup(options.hostname, { all: true }, (_error, entries) => {
      record({ host: options.hostname, addresses: entries.map(entry => entry.address) });
    });
    return httpsRequest(
      {
        ...options,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions?.all === true
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4),
      },
      onResponse,
    );
  };
}

/**
 * Starts the three hosts. `seen` lists every request, `looked` every name the address rules looked up, and
 * `connected` the addresses the walk's own lookup handed to each connection. `answers[host](path)` gives a
 * body, or undefined for a 404; `deps` are what the walk is given.
 */
export async function startFakeCalDav() {
  const folder = mkdtempSync(join(tmpdir(), 'calendar-signin-'));
  const keyFile = join(folder, 'key.pem');
  const certFile = join(folder, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${BASE_HOST}`,
      '-addext',
      `subjectAltName=DNS:${BASE_HOST},DNS:${HOME_HOST},DNS:${OTHER_HOST}`,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  const tlsKey = readFileSync(keyFile);
  const tlsCert = readFileSync(certFile);
  const fake = { folder, seen: [], looked: [], connected: [], answers: {}, deps: {}, ports: {} };

  function host(name) {
    const server = createHttpsServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
      fake.seen.push({ host: name, method: req.method, path: req.url, depth: req.headers.depth });
      const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401);
        res.end();
        return;
      }
      const answer = fake.answers[name]?.(req.url, res);
      if (answer === 'handled') {
        return;
      }
      if (answer === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(answer);
    });
    return new Promise(done =>
      server.listen(0, '127.0.0.1', () => {
        fake.ports[name] = server.address().port;
        done(server);
      }),
    );
  }

  const servers = [await host(BASE_HOST), await host(HOME_HOST), await host(OTHER_HOST)];
  fake.url = name => `https://${name}:${fake.ports[name]}`;
  fake.account = () => ({ url: `${fake.url(BASE_HOST)}/`, username: USER, password: PASSWORD, email: USER });

  fake.reset = () => {
    fake.seen = [];
    fake.looked = [];
    fake.connected = [];
    fake.answers = {
      [BASE_HOST]: path => {
        if (path === '/') {
          return multistatus({ href: '/', props: principalProp(`/${ACCOUNT_ID}/principal/`) });
        }
        if (path === `/${ACCOUNT_ID}/principal/`) {
          return multistatus({ href: path, props: homeProp(`${fake.url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`) });
        }
        return undefined;
      },
      [HOME_HOST]: path => {
        if (path === `/${ACCOUNT_ID}/calendars/`) {
          return multistatus({ href: path, props: principalProp(`/${ACCOUNT_ID}/principal/`) });
        }
        if (path === `/${ACCOUNT_ID}/principal/`) {
          return multistatus({ href: path, props: homeProp(`${fake.url(HOME_HOST)}/${ACCOUNT_ID}/calendars/`) });
        }
        return undefined;
      },
    };
    fake.deps = {
      resolve: async name => {
        fake.looked.push(name);
        return [PUBLIC_ADDRESS];
      },
      ownNetworks: ownNetworks({}),
      tls: { ca: tlsCert },
      request: routedRequest(entry => fake.connected.push(entry)),
    };
  };

  fake.close = () => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    rmSync(folder, { recursive: true, force: true });
  };
  return fake;
}
