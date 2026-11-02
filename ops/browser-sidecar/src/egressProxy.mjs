// The browser's only way out. The browser container sits on an internal network with nothing on it
// but this gateway, and Chromium is pointed at it as its proxy, so every request it makes (the
// first page, each redirect, every subrequest, form posts, WebSocket tunnels) is checked here, not
// only the address the model asked for.
//
// Each request's host is resolved once, here, and refused if it resolves anywhere private. The
// connection then goes to the address that was checked, never to the name, so a name that changes
// its answer between the check and the connect (DNS rebinding) cannot reach a private address.
//
// The gateway also relays the app server's calls to the sidecar's API, so the server and the
// browser never share a network, and it checks the server's shared secret, so the browser's
// container never holds it.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { URL } from 'node:url';

import { resolvePublic, safeNavigationTarget } from './urlSafety.mjs';

/** Request headers that describe the hop to the proxy, not the request; never forwarded. */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const IDLE_TIMEOUT_MS = 120_000;

function defaultDial({ host, port }) {
  return netConnect({ host, port });
}

/** `host:port` from a CONNECT line, with an IPv6 literal's brackets kept for `resolvePublic`. */
function parseAuthority(authority) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority ?? '');
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? { host: match[1], port } : undefined;
}

function forwardedHeaders(headers) {
  const out = {};
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map(token => token.trim().toLowerCase())
      .filter(token => token !== ''),
  );
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(key) && !named.has(key) && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * `GET /check?url=…`: whether the browser may be sent to an address, by the same rules the proxy
 * applies to every request. The sidecar asks this before it opens a page, so the model gets a plain
 * refusal instead of a failed load; the sidecar has no DNS of its own to answer it.
 */
async function answerCheck({ req, res, resolve }) {
  const asked = new URL(req.url ?? '/', 'http://gateway.invalid');
  const raw = asked.searchParams.get('url');
  if (req.method !== 'GET' || asked.pathname !== '/check' || raw === null) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const target = await safeNavigationTarget(raw, { resolve });
  const body = target.ok ? { ok: true, url: target.url.href } : { ok: false, reason: target.reason };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/**
 * The forward proxy. `resolve` and `dial` exist so tests can stand in for DNS and for the final TCP
 * connect; every policy decision still runs through `resolvePublic`.
 */
export function createEgressProxy({ resolve, dial = defaultDial, log = () => undefined } = {}) {
  const server = createHttpServer();

  server.on('request', (req, res) => {
    void (async () => {
      if (req.url?.startsWith('/')) {
        await answerCheck({ req, res, resolve });
        return;
      }
      let url;
      try {
        url = new URL(req.url ?? '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('absolute http URL required');
        return;
      }
      if (url.protocol !== 'http:') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('only http is proxied this way');
        return;
      }
      const checked = await resolvePublic(url.hostname, { resolve });
      if (!checked.ok) {
        log({ refused: url.hostname, reason: checked.reason });
        res.writeHead(403, { 'content-type': 'text/plain' }).end(`refused: ${checked.reason}`);
        return;
      }
      const port = url.port === '' ? 80 : Number(url.port);
      const upstream = httpRequest({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...forwardedHeaders(req.headers), host: url.host },
        createConnection: () => dial({ host: checked.addresses[0], port }),
        timeout: IDLE_TIMEOUT_MS,
      });
      upstream.on('response', upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, forwardedHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream error');
        } else {
          res.destroy();
        }
      });
      req.pipe(upstream);
    })();
  });

  server.on('connect', (req, clientSocket, head) => {
    void (async () => {
      clientSocket.on('error', () => undefined);
      const authority = parseAuthority(req.url);
      if (authority === undefined) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const checked = await resolvePublic(authority.host, { resolve });
      if (!checked.ok) {
        log({ refused: authority.host, reason: checked.reason });
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = dial({ host: checked.addresses[0], port: authority.port });
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
      clientSocket.setTimeout(IDLE_TIMEOUT_MS, () => clientSocket.destroy());
      upstream.on('error', () => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        upstream.on('close', () => clientSocket.destroy());
        clientSocket.on('close', () => upstream.destroy());
      });
    })();
  });

  // Chromium tunnels WebSockets with CONNECT; a plain-HTTP upgrade through the proxy is not used.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n');
  });

  return server;
}

/** The shortest shared secret the relay accepts, the same floor the app server enforces. */
const MIN_SECRET_LENGTH = 32;

function secretMatches({ given, secret }) {
  if (typeof given !== 'string') {
    return false;
  }
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * The app server's way to the sidecar's API: each call must carry the shared secret in the
 * `X-Browser-Secret` header, which is checked here and not passed on.
 */
export function createApiRelay({ host, port, secret }) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BROWSER_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  return createHttpServer((req, res) => {
    if (!secretMatches({ given: req.headers['x-browser-secret'], secret })) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'wrong or missing secret' }));
      return;
    }
    const headers = forwardedHeaders(req.headers);
    delete headers['x-browser-secret'];
    const upstream = httpRequest({ host, port, method: req.method, path: req.url, headers });
    upstream.on('response', upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardedHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'the browser could not be reached' }));
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  });
}
