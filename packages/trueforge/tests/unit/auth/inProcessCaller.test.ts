import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext, type RequestContext } from '../../../src/auth/identity';
import { grantInProcessCaller } from '../../../src/auth/inProcessCaller';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { closeServer, listeningPort } from '../../fixtures/listenPort';

const DANA: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'dana', type: 'user', display_name: 'Dana' },
  roles: [],
  user_credential: null,
};

const CHAT = '/api/v1/sessions/chat-1/';

/** Signed in only with a real credential, which these requests never carry. */
const noOne: Authenticator = {
  authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
};

function app() {
  const server = new Hono();
  server.use('*', createAuthMiddleware(noOne));
  server.get('*', c => c.json({ id: resolveRequestContext(c).subject.id }));
  return server;
}

describe('a request the server makes in its own process', () => {
  it('acts as the person it was granted for, only in the one chat, and only while the grant lasts', async () => {
    const grant = grantInProcessCaller({ context: DANA, pathPrefix: CHAT });
    const server = app();
    const asDana = await server.fetch(new Request(`http://localhost${CHAT}turns`), grant.env);
    expect(asDana.status).toBe(200);
    await expect(asDana.json()).resolves.toEqual({ id: 'dana' });
    for (const path of ['/api/v1/sessions/other/turns', '/api/v1/user/reach', '/api/v1/sessions/chat-1']) {
      expect((await server.fetch(new Request(`http://localhost${path}`), grant.env)).status).toBe(401);
    }
    grant.revoke();
    expect((await server.fetch(new Request(`http://localhost${CHAT}turns`), grant.env)).status).toBe(401);
  });

  it('gives nothing to a look-alike of the grant: only the very object it handed out counts', async () => {
    const grant = grantInProcessCaller({ context: DANA, pathPrefix: CHAT });
    const server = app();
    expect((await server.fetch(new Request(`http://localhost${CHAT}turns`), { ...grant.env })).status).toBe(401);
    expect((await server.fetch(new Request(`http://localhost${CHAT}turns`), {})).status).toBe(401);
    grant.revoke();
  });

  it('gives a request from the network no identity, whatever headers it carries', async () => {
    const grant = grantInProcessCaller({ context: DANA, pathPrefix: CHAT });
    const listener = serve({ fetch: app().fetch, port: 0, hostname: '127.0.0.1' });
    try {
      const port = await listeningPort(listener);
      for (const headers of [
        {},
        { 'x-aman-in-process-caller': 'guess' },
        { 'x-aman-in-process-caller': 'a'.repeat(43), 'sec-fetch-site': 'same-origin' },
      ]) {
        const response = await fetch(`http://127.0.0.1:${String(port)}${CHAT}turns`, { headers });
        expect(response.status).toBe(401);
      }
    } finally {
      grant.revoke();
      await closeServer(listener);
    }
  });
});
