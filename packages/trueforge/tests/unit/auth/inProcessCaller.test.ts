import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext, type RequestContext } from '../../../src/auth/identity';
import { grantInProcessCaller, IN_PROCESS_CALLER_HEADER } from '../../../src/auth/inProcessCaller';
import { createAuthMiddleware } from '../../../src/auth/middleware';

const DANA: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'dana', type: 'user', display_name: 'Dana' },
  roles: [],
  user_credential: null,
};

/** Signed in only with a real credential, which these requests never carry. */
const noOne: Authenticator = {
  authenticate: () => Promise.reject(new HTTPException(401, { message: 'Authentication required' })),
};

function app() {
  const server = new Hono();
  server.use('*', createAuthMiddleware(noOne));
  server.get('/me', c => c.json({ id: resolveRequestContext(c).subject.id }));
  return server;
}

describe('a request the server makes in its own process', () => {
  it('acts as the person it was granted for, and only while the grant lasts', async () => {
    const grant = grantInProcessCaller(DANA);
    const server = app();
    const asDana = await server.request('/me', { headers: { [IN_PROCESS_CALLER_HEADER]: grant.key } });
    expect(asDana.status).toBe(200);
    await expect(asDana.json()).resolves.toEqual({ id: 'dana' });
    grant.revoke();
    expect((await server.request('/me', { headers: { [IN_PROCESS_CALLER_HEADER]: grant.key } })).status).toBe(401);
  });

  it('gives a guessed or empty key nothing', async () => {
    grantInProcessCaller(DANA);
    const server = app();
    for (const key of ['', 'guess', 'a'.repeat(43)]) {
      expect((await server.request('/me', { headers: { [IN_PROCESS_CALLER_HEADER]: key } })).status).toBe(401);
    }
    expect((await server.request('/me')).status).toBe(401);
  });
});
