import { OpenAPIHono } from '@hono/zod-openapi';
import { createRequestBodyLimitMiddleware } from '../../src/app';
import configuration from '../../src/config';

const MAX_SIZE = 16;

function createApp() {
  const app = new OpenAPIHono();
  let handlerCalled = false;
  app.use('*', createRequestBodyLimitMiddleware(MAX_SIZE));
  app.get('/test', c => c.json({ ok: true }));
  app.post('/test', async c => {
    handlerCalled = true;
    await c.req.json();
    return c.json({ ok: true });
  });
  return {
    app,
    wasHandlerCalled: () => handlerCalled,
  };
}

describe('createRequestBodyLimitMiddleware', () => {
  it('leaves bounded JSON headroom for one maximum-size base64 document', () => {
    const maxDocumentBytes = 25 * 1024 * 1024;
    const base64Bytes = 4 * Math.ceil(maxDocumentBytes / 3);

    expect(configuration.MAX_REQUEST_BODY_BYTES - base64Bytes).toBeGreaterThan(1024 * 1024);
  });

  it('returns 413 when Content-Length exceeds the max and does not call the handler', async () => {
    const { app, wasHandlerCalled } = createApp();
    const body = 'x'.repeat(MAX_SIZE + 1);

    const response = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { message: `Request body exceeds the maximum size of ${String(MAX_SIZE)} bytes` },
    });
    expect(wasHandlerCalled()).toBe(false);
  });

  it('allows a body at or under the max', async () => {
    const { app, wasHandlerCalled } = createApp();
    const body = JSON.stringify({ a: 1 }); // 7 bytes

    const response = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(wasHandlerCalled()).toBe(true);
  });

  it('passes GET requests with no body', async () => {
    const { app } = createApp();

    const response = await app.request('/test');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
