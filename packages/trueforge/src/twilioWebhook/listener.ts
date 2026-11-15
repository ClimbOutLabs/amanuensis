import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'winston';
import { WebSocketServer, type WebSocket } from 'ws';

import type { TwilioSettings } from '../config';
import { verifyTwilioSignature } from './signature';

/** The most a webhook body may hold. Twilio's form posts are far smaller. */
const MAX_BODY_BYTES = 64 * 1024;

/** What a route answers. Twilio reads TwiML, which is XML. */
interface TwilioWebhookReply {
  status: 200 | 400 | 403;
  body: string;
}

/**
 * One Twilio address on the listener. It runs only after the request signature has been checked, so a handler never
 * sees an unsigned request.
 */
export interface TwilioWebhookRoute {
  path: string;
  method: 'POST';
  /** `query` is the signed address's own query, which Aman set when it asked Twilio to call back. */
  handle(input: { params: URLSearchParams; query: URLSearchParams }): Promise<TwilioWebhookReply>;
}

/**
 * One WebSocket address on the listener, such as a call's media stream, of the form `<path>/<id>`. Twilio forbids a
 * query string on one, but not a path. It opens only after the handshake's signature has been checked; what the socket
 * then carries is the route's to check.
 */
export interface TwilioSocketRoute {
  path: string;
  /** The shape an id must have, matched against the address as sent. Anything else is refused before the signature. */
  idShape: RegExp;
  /** Whether the id names something that may open a socket; an id that does not is refused before the upgrade. */
  admits(id: string): Promise<boolean>;
  open(socket: WebSocket, id: string): void;
}

/** The most one media frame may hold. Twilio sends 20 ms of audio at a time, far smaller. */
const MAX_SOCKET_FRAME_BYTES = 64 * 1024;

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * The app behind the Twilio port: only the routes given to it, each behind the signature check, and nothing else.
 * It shares no code path with the main app, so sign-in and the rest of Aman are never reachable here. The public URL
 * a signature is checked against is built from the configured address, never from a header the caller sent.
 */
function createTwilioWebhookApp({
  settings,
  routes,
  logger,
}: {
  settings: Pick<TwilioSettings, 'authToken' | 'webhookPublicUrl'>;
  routes: readonly TwilioWebhookRoute[];
  logger: Logger;
}): Hono {
  const app = new Hono();
  const known = new Map(routes.map(route => [`${route.method} ${route.path}`, route]));

  app.use(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: c => c.body(null, 413) }));
  app.onError((error, c) => {
    // Only the address and the kind of error: the message can carry a phone number or the text itself.
    logger.error('A Twilio request failed', { path: new URL(c.req.url).pathname, error_class: error.name });
    return c.body(EMPTY_TWIML, 500, { 'Content-Type': 'text/xml; charset=utf-8' });
  });
  app.all('*', async c => {
    const url = new URL(c.req.url);
    const route = known.get(`${c.req.method} ${url.pathname}`);
    if (route === undefined) {
      return c.body(null, 404);
    }
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return c.body(null, 400);
    }
    const text = await c.req.text();
    const params = new URLSearchParams(text);
    const verified = verifyTwilioSignature({
      authToken: settings.authToken,
      url: `${settings.webhookPublicUrl}${url.pathname}${url.search}`,
      params,
      signature: c.req.header('x-twilio-signature'),
    });
    if (!verified) {
      // Nothing about the request is logged: it may carry a phone number or a message.
      logger.warn('A Twilio request was refused because its signature did not match', { path: route.path });
      return c.body(null, 403);
    }
    const reply = await route.handle({ params, query: url.searchParams });
    return c.body(reply.body, reply.status, { 'Content-Type': 'text/xml; charset=utf-8' });
  });
  return app;
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Takes WebSocket upgrades for the socket routes only. Twilio signs the handshake of a media stream like a webhook,
 * over the stream's own address and no fields; the address may be written as wss or https, and either form is checked
 * against the configured public address. Any other upgrade is refused.
 */
function attachSocketRoutes({
  server,
  settings,
  sockets,
  logger,
}: {
  server: ServerType;
  settings: Pick<TwilioSettings, 'authToken' | 'webhookPublicUrl'>;
  sockets: readonly TwilioSocketRoute[];
  logger: Logger;
}): void {
  const upgrades = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_FRAME_BYTES });
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = socketRouteFor({ sockets, pathname: url.pathname });
    if (match === undefined) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    const { route, id } = match;
    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const httpsUrl = `${settings.webhookPublicUrl}${url.pathname}${url.search}`;
    const signed = [httpsUrl, httpsUrl.replace(/^https:/, 'wss:')].some(candidate =>
      verifyTwilioSignature({
        authToken: settings.authToken,
        url: candidate,
        params: new URLSearchParams(),
        signature,
      }),
    );
    if (!signed) {
      logger.warn('A Twilio socket was refused because its signature did not match', { path: route.path });
      refuseUpgrade(socket, '403 Forbidden');
      return;
    }
    // Checked after the signature, so only a request Twilio signed for this exact address costs a lookup.
    void (async () => {
      try {
        const admitted = await route.admits(id).catch(() => false);
        if (socket.destroyed) {
          return;
        }
        if (!admitted) {
          refuseUpgrade(socket, '404 Not Found');
          return;
        }
        upgrades.handleUpgrade(request, socket, head, ws => {
          // A bad frame or a broken connection ends this socket only. It goes before the route sees the socket.
          ws.on('error', () => {
            ws.terminate();
          });
          route.open(ws, id);
        });
      } catch (error) {
        logger.warn('A Twilio socket was refused because it could not be opened', {
          error_class: error instanceof Error ? error.name : typeof error,
        });
        refuseUpgrade(socket, '404 Not Found');
      }
    })();
  };
  // Nothing on this port is trusted, so an upgrade that fails in any way is refused and the server carries on.
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node drops its own error listener before this event, so a connection that resets while the call is looked up
    // would otherwise have none. It goes first, before any work that waits.
    socket.on('error', () => {
      socket.destroy();
    });
    try {
      handleUpgrade(request, socket, head);
    } catch (error) {
      logger.warn('A Twilio socket was refused because its request could not be read', {
        error_class: error instanceof Error ? error.name : typeof error,
      });
      refuseUpgrade(socket, '404 Not Found');
    }
  });
}

/** The socket route a path belongs to, and the one id after its prefix. The id is never decoded. */
function socketRouteFor({
  sockets,
  pathname,
}: {
  sockets: readonly TwilioSocketRoute[];
  pathname: string;
}): { route: TwilioSocketRoute; id: string } | undefined {
  for (const route of sockets) {
    const prefix = `${route.path}/`;
    if (pathname.startsWith(prefix)) {
      const id = pathname.slice(prefix.length);
      return route.idShape.test(id) ? { route, id } : undefined;
    }
  }
  return undefined;
}

/**
 * Starts the Twilio listener on its own port. It resolves once the port is open and fails when the port cannot be
 * used, so the server never sends texts while unable to hear a STOP.
 */
export function startTwilioWebhookListener({
  settings,
  hostname,
  routes,
  sockets = [],
  logger,
}: {
  settings: Pick<TwilioSettings, 'authToken' | 'webhookPublicUrl' | 'webhookPort'>;
  hostname: string;
  routes: readonly TwilioWebhookRoute[];
  /** WebSocket addresses, such as a call's media stream. */
  sockets?: readonly TwilioSocketRoute[];
  logger: Logger;
}): Promise<ServerType> {
  const app = createTwilioWebhookApp({ settings, routes, logger });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: settings.webhookPort, hostname }, info => {
      logger.info(`Twilio listener on ${hostname}:${String(info.port)} (Twilio routes only)`);
      resolve(server);
    });
    attachSocketRoutes({ server, settings, sockets, logger });
    server.on('error', (error: unknown) => {
      // Before the port is open this fails the start. After, it is only logged, by its kind.
      if (server.listening) {
        logger.error('The Twilio listener failed', { error_class: error instanceof Error ? error.name : typeof error });
        return;
      }
      reject(
        new Error(
          `The Twilio listener could not use port ${String(settings.webhookPort)}. Set TWILIO_WEBHOOK_PORT to a free port, then restart Aman.`,
          { cause: error },
        ),
      );
    });
  });
}

/** The Twilio listener when texts are set up on this server, otherwise nothing is started. */
export async function twilioListenerFor({
  twilio,
  hostname,
  routes,
  sockets = [],
  logger,
}: {
  twilio: TwilioSettings | undefined;
  hostname: string;
  routes: readonly TwilioWebhookRoute[];
  sockets?: readonly TwilioSocketRoute[];
  logger: Logger;
}): Promise<ServerType | undefined> {
  return twilio === undefined
    ? undefined
    : startTwilioWebhookListener({ settings: twilio, hostname, routes, sockets, logger });
}
