import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { createLogger, transports } from 'winston';

import type { Authenticator } from '../../../src/auth/authenticator';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { createClientCertificateMiddleware } from '../../../src/http/tls';

const logger = createLogger({ transports: [new transports.Console({ silent: true })] });

/** Signs a person in from `user=<name>` in the cookie, which is one of the headers a voice line forwards. */
const authenticator: Authenticator = {
  authenticate: c => {
    const user = /user=(\w+)/.exec(c.req.header('cookie') ?? '')?.[1];
    if (user === undefined) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve({
      ...STANDALONE_REQUEST_CONTEXT,
      tenant_id: 'tenant-a',
      subject: { id: user, type: 'user', display_name: user },
    });
  },
};

/** The server as it runs with mutual TLS on: every route needs a certificate, and voice calls back into it. */
export function mtlsApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  app.use('*', createClientCertificateMiddleware(logger));
  app.use('*', createAuthMiddleware(authenticator));
  app.get('/api/v1/sessions/:id', c => c.json({ id: c.req.param('id') }));
  return app;
}

/** What a person's browser connection looks like once the certificate check has passed. */
export function authorizedSocket(): TLSSocket {
  const socket = new TLSSocket(new Socket());
  socket.authorized = true;
  return socket;
}
