import { createServer } from 'node:net';
import { Writable } from 'node:stream';

import winston from 'winston';

import {
  EMPTY_TWIML,
  startTwilioWebhookListener,
  twilioListenerFor,
  type TwilioWebhookRoute,
} from '../../../src/twilioWebhook/listener';
import { twilioSignature } from '../../../src/twilioWebhook/signature';
import { closeServer, listeningPort } from '../../fixtures/listenPort';

const settings = { authToken: 'token-for-tests', webhookPublicUrl: 'https://aman.example.invalid', webhookPort: 0 };
const logger = winston.createLogger({ silent: true });

async function listen(routes: readonly TwilioWebhookRoute[], log = logger) {
  const server = await startTwilioWebhookListener({ settings, hostname: '127.0.0.1', routes, logger: log });
  const port = await listeningPort(server);
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: () => closeServer(server),
  };
}

function signed({ path, fields }: { path: string; fields: Record<string, string> }) {
  const params = new URLSearchParams(fields);
  return {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature({
        authToken: settings.authToken,
        url: `${settings.webhookPublicUrl}${path}`,
        params,
      }),
    },
    body: params.toString(),
  };
}

describe('the Twilio listener', () => {
  const handle = jest.fn();
  const route: TwilioWebhookRoute = { method: 'POST', path: '/twilio/test', handle };
  let listener: Awaited<ReturnType<typeof listen>>;

  beforeEach(async () => {
    handle.mockReset().mockResolvedValue({ status: 200, body: EMPTY_TWIML });
    listener = await listen([route]);
  });
  afterEach(async () => {
    await listener.close();
  });

  it('runs a route for a request signed with the account’s token', async () => {
    const { headers, body } = signed({ path: '/twilio/test', fields: { From: '+15550111', Body: 'hi' } });
    const response = await fetch(`${listener.base}/twilio/test`, { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');
    await expect(response.text()).resolves.toBe(EMPTY_TWIML);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsigned request and never runs the route', async () => {
    const response = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'From=%2B15550111&Body=STOP',
    });
    expect(response.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a badly signed request, a changed body and a signature made for another address', async () => {
    const { headers, body } = signed({ path: '/twilio/test', fields: { From: '+15550111', Body: 'hi' } });
    const badly = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers: { ...headers, 'x-twilio-signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      body,
    });
    expect(badly.status).toBe(403);
    const changed = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers,
      body: 'From=%2B15550111&Body=STOP',
    });
    expect(changed.status).toBe(403);
    const other = signed({ path: '/twilio/other', fields: { From: '+15550111', Body: 'hi' } });
    const wrongPath = await fetch(`${listener.base}/twilio/test`, { method: 'POST', ...other });
    expect(wrongPath.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it('builds the address from the configured public address, not from the Host header', async () => {
    const { headers, body } = signed({ path: '/twilio/test', fields: { Body: 'hi' } });
    const response = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers: { ...headers, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
      body,
    });
    expect(response.status).toBe(200);
  });

  it('serves nothing but its own routes: no app, sign-in, health or docs address answers', async () => {
    for (const path of [
      '/',
      '/healthz',
      '/api/v1/auth/me',
      '/api/v1/docs',
      '/api/v1/user/reach',
      '/twilio',
      '/twilio/test/',
    ]) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${listener.base}${path}`, {
          method,
          ...(method === 'POST'
            ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' }
            : {}),
        });
        expect([path, method, response.status]).toEqual([path, method, 404]);
        await expect(response.text()).resolves.toBe('');
      }
    }
    expect((await fetch(`${listener.base}/twilio/test`)).status).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a form and one that is too large', async () => {
    const json = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twilio-signature': 'x' },
      body: '{}',
    });
    expect(json.status).toBe(400);
    const large = await fetch(`${listener.base}/twilio/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' },
      body: `a=${'b'.repeat(70 * 1024)}`,
    });
    expect(large.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it('answers a route that fails with an empty reply, and logs only the address and the kind of error', async () => {
    const errors: unknown[] = [];
    const recording = winston.createLogger({
      transports: [
        new winston.transports.Stream({
          stream: new Writable({
            write(chunk: Buffer, _encoding, done) {
              errors.push(JSON.parse(chunk.toString()));
              done();
            },
          }),
        }),
      ],
    });
    const failing = await listen(
      [{ method: 'POST', path: '/twilio/fails', handle: () => Promise.reject(new TypeError('+15550111 said hi')) }],
      recording,
    );
    try {
      const { headers, body } = signed({ path: '/twilio/fails', fields: { From: '+15550111', Body: 'hi' } });
      const response = await fetch(`${failing.base}/twilio/fails`, { method: 'POST', headers, body });
      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toBe(EMPTY_TWIML);
      expect(errors).toContainEqual({
        level: 'error',
        message: 'A Twilio request failed',
        path: '/twilio/fails',
        error_class: 'TypeError',
      });
      expect(JSON.stringify(errors)).not.toContain('5550111');
    } finally {
      await failing.close();
    }
  });
});

describe('starting the Twilio listener', () => {
  it('fails when its port is taken, so the server does not run without hearing STOP', async () => {
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
    const address = holder.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The holder has no port.');
    }
    try {
      await expect(
        startTwilioWebhookListener({
          settings: { ...settings, webhookPort: address.port },
          hostname: '127.0.0.1',
          routes: [],
          logger,
        }),
      ).rejects.toThrow(`The Twilio listener could not use port ${String(address.port)}`);
    } finally {
      await new Promise<void>(resolve => holder.close(() => resolve()));
    }
  });

  it('starts nothing when texts are not set up', async () => {
    await expect(twilioListenerFor({ twilio: undefined, hostname: '127.0.0.1', routes: [], logger })).resolves.toBe(
      undefined,
    );
  });

  it('starts the listener when texts are set up', async () => {
    const server = await twilioListenerFor({
      twilio: { ...settings, accountSid: `AC${'1'.repeat(32)}`, fromNumber: '+15550100', maxTextsPerDay: 500 },
      hostname: '127.0.0.1',
      routes: [],
      logger,
    });
    expect(server?.listening).toBe(true);
    if (server !== undefined) {
      await closeServer(server);
    }
  });
});
