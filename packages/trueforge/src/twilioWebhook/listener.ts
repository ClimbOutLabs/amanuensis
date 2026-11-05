import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'winston';

import type { TwilioSettings } from '../config';
import { verifyTwilioSignature } from './signature';

/** The most a webhook body may hold. Twilio's form posts are far smaller. */
const MAX_BODY_BYTES = 64 * 1024;

/** What a route answers. Twilio reads TwiML, which is XML. */
export interface TwilioWebhookReply {
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
  handle(input: { params: URLSearchParams }): Promise<TwilioWebhookReply>;
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * The app behind the Twilio port: only the routes given to it, each behind the signature check, and nothing else.
 * It shares no code path with the main app, so sign-in and the rest of Aman are never reachable here. The public URL
 * a signature is checked against is built from the configured address, never from a header the caller sent. A WebSocket
 * route would attach to the server's `upgrade` event and check the same signature with `verifyTwilioSignature`.
 */
export function createTwilioWebhookApp({
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
    const reply = await route.handle({ params });
    return c.body(reply.body, reply.status, { 'Content-Type': 'text/xml; charset=utf-8' });
  });
  return app;
}

/** Starts the Twilio listener on its own port. It is only started when texts are set up. */
export function startTwilioWebhookListener({
  settings,
  hostname,
  routes,
  logger,
}: {
  settings: Pick<TwilioSettings, 'authToken' | 'webhookPublicUrl' | 'webhookPort'>;
  hostname: string;
  routes: readonly TwilioWebhookRoute[];
  logger: Logger;
}): ServerType {
  const app = createTwilioWebhookApp({ settings, routes, logger });
  const server = serve({ fetch: app.fetch, port: settings.webhookPort, hostname }, info => {
    logger.info(`Twilio listener on ${hostname}:${String(info.port)} (Twilio routes only)`);
  });
  server.on('error', (error: unknown) => {
    logger.error('The Twilio listener could not start', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return server;
}
