import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger, type Logger } from 'winston';
import { createAccessLogMiddleware } from '../../src/app';

function makeSpiedLogger() {
  const logger: Logger = createLogger({ silent: true, transports: [] });
  const debug = jest.spyOn(logger, 'debug');
  const info = jest.spyOn(logger, 'info');
  return { logger, debug, info };
}

function createApp(logger: Logger) {
  const app = new OpenAPIHono();
  app.use('*', createAccessLogMiddleware(logger));
  app.get('/ok', c => c.json({ ok: true }));
  app.get('/redirect', c => c.redirect('/ok', 301));
  app.get('/boom', c => c.json({ error: 'boom' }, 500));
  app.post('/ok', c => c.json({ ok: true }));
  app.put('/ok', c => c.json({ ok: true }));
  app.delete('/ok', c => c.json({ ok: true }));
  app.get('/healthz', c => c.json({ ok: true }));
  return app;
}

describe('createAccessLogMiddleware', () => {
  it('logs GET 200 at debug, not info', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/ok');
    expect(response.status).toBe(200);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        method: 'GET',
        path: '/ok',
        status: 200,
      }),
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('logs GET 404 at info, not debug', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/missing');
    expect(response.status).toBe(404);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        method: 'GET',
        path: '/missing',
        status: 404,
      }),
    );
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs GET 500 at info', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/boom');
    expect(response.status).toBe(500);

    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs POST 200 at info', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/ok', { method: 'POST' });
    expect(response.status).toBe(200);

    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs PUT 200 at info', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/ok', { method: 'PUT' });
    expect(response.status).toBe(200);

    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs DELETE 200 at info', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/ok', { method: 'DELETE' });
    expect(response.status).toBe(200);

    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs GET 301 at debug (locks in the < 400 boundary including 3xx)', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/redirect');
    expect(response.status).toBe(301);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('logs HEAD 200 at info (downgrade applies to GET only)', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/ok', { method: 'HEAD' });
    expect(response.status).toBe(200);

    // The middleware checks method === 'GET', so HEAD stays at info.
    expect(info).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it('skips /healthz entirely (neither debug nor info)', async () => {
    const { logger, debug, info } = makeSpiedLogger();
    const app = createApp(logger);

    const response = await app.request('/healthz');
    expect(response.status).toBe(200);

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('emits duration_ms as a non-negative number and echoes method/path/status', async () => {
    const { logger, debug } = makeSpiedLogger();
    const app = createApp(logger);

    await app.request('/ok');

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        method: 'GET',
        path: '/ok',
        status: 200,
        duration_ms: expect.any(Number),
      }),
    );
    const fields: unknown = Reflect.get(debug.mock.calls[0] ?? [], 1);
    expect(fields).toEqual(expect.objectContaining({ duration_ms: expect.any(Number) }));
    expect(Reflect.get(Object(fields), 'duration_ms')).toBeGreaterThanOrEqual(0);
  });
});
