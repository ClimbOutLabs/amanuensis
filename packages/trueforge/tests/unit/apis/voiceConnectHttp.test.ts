/** POST /connect: who may open a voice connection, and what a ticket carries. */
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createLogger, transports } from 'winston';

import { createVoiceRouter } from '../../../src/apis/voice';
import type { Authenticator } from '../../../src/auth/authenticator';
import { STANDALONE_REQUEST_CONTEXT, resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import configuration from '../../../src/config';
import { voiceTickets } from '../../../src/voice/voiceTickets';

let sttReady = true;
jest.mock('../../../src/voice/sttAvailability', () => ({
  ...jest.requireActual('../../../src/voice/sttAvailability'),
  isVoiceAvailable: () => sttReady,
}));
let modelError: Error | undefined;
jest.mock('../../../src/voice/voiceSocket', () => ({
  ...jest.requireActual('../../../src/voice/voiceSocket'),
  readyVadModel: () => (modelError === undefined ? Promise.resolve('/model.onnx') : Promise.reject(modelError)),
}));

const authenticator: Authenticator = {
  authenticate: c => {
    const user = c.req.header('x-test-user');
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

describe('POST /connect', () => {
  const logger = createLogger({ transports: [new transports.Console({ silent: true })] });
  const asked: { url: string; cookie: string | null }[] = [];
  let chatStatus = 200;

  function app(): OpenAPIHono {
    const hono = new OpenAPIHono();
    hono.use('*', createAuthMiddleware(authenticator));
    hono.route(
      '/',
      createVoiceRouter({
        logger,
        resolveRequestContext,
        selfFetch: request => {
          asked.push({ url: request.url, cookie: request.headers.get('cookie') });
          return new Response('{}', { status: chatStatus });
        },
      }),
    );
    return hono;
  }

  const connect = (body: unknown, user: string | null = 'alice') =>
    app().request('/connect', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'session=abc',
        host: 'aman.local',
        ...(user === null ? {} : { 'x-test-user': user }),
      },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    sttReady = true;
    modelError = undefined;
    chatStatus = 200;
    asked.length = 0;
    configuration.TTS_ENABLED = true;
  });

  it('hands a signed-in person a one-time ticket for their own chat, bound to who they are', async () => {
    const response = await connect({ session_id: 'chat-1', voice: 'af_bella', client_timezone: 'Europe/Paris' });
    expect(response.status).toBe(200);
    const { data } = z
      .object({
        data: z.object({ ticket: z.string(), protocol: z.string(), path: z.string(), expires_in_seconds: z.number() }),
      })
      .parse(await response.json());
    expect(data.protocol).toBe('aman-voice.v1');
    expect(data.path).toBe('/api/v1/voice/stream');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const ticket = voiceTickets.redeem(data.ticket);
    expect(ticket).toMatchObject({
      tenantId: 'tenant-a',
      subjectId: 'alice',
      sessionId: 'chat-1',
      voice: 'af_bella',
      timezone: 'Europe/Paris',
    });
    expect(ticket?.headers['cookie']).toBe('session=abc');
    // The chat's own route, called with the person's own credentials, decided they may use it.
    expect(asked).toEqual([{ url: 'http://aman.local/api/v1/sessions/chat-1', cookie: 'session=abc' }]);
  });

  it('turns away someone who is not signed in', async () => {
    expect((await connect({ session_id: 'chat-1' }, null)).status).toBe(401);
  });

  it.each([403, 404])('issues no ticket for a chat the person may not use (%s)', async status => {
    chatStatus = status;
    const response = await connect({ session_id: 'someone-elses' });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('could not be found');
  });

  it('says what to do when voice mode is off, speech to text is not ready, or the listening model is missing', async () => {
    configuration.TTS_ENABLED = false;
    const off = await connect({ session_id: 'chat-1' });
    expect([off.status, await off.text()]).toEqual([503, expect.stringContaining('turned off')]);
    configuration.TTS_ENABLED = true;
    sttReady = false;
    expect(await (await connect({ session_id: 'chat-1' })).text()).toContain('Try again in a minute');
    sttReady = true;
    modelError = new Error('boom');
    expect(await (await connect({ session_id: 'chat-1' })).text()).toContain('Restart Aman');
  });

  it('refuses a request that names no chat', async () => {
    expect((await connect({})).status).toBe(400);
  });
});
