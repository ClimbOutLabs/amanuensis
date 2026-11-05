import type { ServerType } from '@hono/node-server';
import winston from 'winston';

import { EMPTY_TWIML, startTwilioWebhookListener, type TwilioWebhookRoute } from '../../../src/twilioWebhook/listener';
import { twilioSignature } from '../../../src/twilioWebhook/signature';
import { closeServer, listeningPort } from '../../fixtures/listenPort';

const settings = { authToken: 'token-for-tests', webhookPublicUrl: 'https://aman.example.invalid', webhookPort: 0 };
const logger = winston.createLogger({ silent: true });

async function listen(routes: readonly TwilioWebhookRoute[]) {
  const server: ServerType = startTwilioWebhookListener({ settings, hostname: '127.0.0.1', routes, logger });
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
});
