import { Hono } from 'hono';
import { Socket } from 'node:net';
import { createLogger, transports } from 'winston';

import { createClientCertificateMiddleware, inProcessFetch } from '../../../src/http/tls';
import { requestAs } from '../../../src/voice/voiceSocket';

const logger = createLogger({ transports: [new transports.Console({ silent: true })] });

/** A server with mutual TLS on, as it runs when `TRUEFORGE_MTLS_ENABLED` is set. */
function mtlsApp() {
  const app = new Hono();
  app.use('*', createClientCertificateMiddleware(logger));
  app.get('/healthz', c => c.text('ok'));
  app.post('/api/v1/sessions/chat-1/turns', c => c.json({ caller: c.req.header('x-test-user') ?? null }));
  return app;
}

describe('client certificates with mutual TLS on', () => {
  it('lets the server reach its own routes without a certificate', async () => {
    const response = await inProcessFetch(mtlsApp())(
      new Request('http://localhost/api/v1/sessions/chat-1/turns', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
  });

  it('lets a voice turn through to the chat route as the person who opened the line', async () => {
    const request = requestAs({
      ticket: {
        tenantId: 'tenant-1',
        subjectId: 'sam',
        sessionId: 'chat-1',
        headers: { 'x-test-user': 'sam@example.test' },
        timezone: undefined,
        voice: undefined,
      },
      selfFetch: inProcessFetch(mtlsApp()),
    });
    const response = await request('/api/v1/sessions/chat-1/turns', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caller: 'sam@example.test' });
  });

  it('turns away a request that arrived without a certificate', async () => {
    const response = await mtlsApp().fetch(new Request('http://localhost/api/v1/sessions/chat-1/turns'), {
      incoming: { socket: new Socket() },
    });
    expect(response.status).toBe(403);
  });

  it('turns away a request that names no line at all instead of failing', async () => {
    const response = await mtlsApp().fetch(
      new Request('http://localhost/api/v1/sessions/chat-1/turns', { method: 'POST' }),
    );
    expect(response.status).toBe(403);
  });

  it('turns away an outside request that copies the in-process shape', async () => {
    const response = await mtlsApp().fetch(
      new Request('http://localhost/api/v1/sessions/chat-1/turns', { method: 'POST' }),
      {},
    );
    expect(response.status).toBe(403);
  });

  it('still answers health checks without a certificate', async () => {
    const response = await mtlsApp().fetch(new Request('http://localhost/healthz'), {
      incoming: { socket: new Socket() },
    });
    expect(response.status).toBe(200);
  });
});
