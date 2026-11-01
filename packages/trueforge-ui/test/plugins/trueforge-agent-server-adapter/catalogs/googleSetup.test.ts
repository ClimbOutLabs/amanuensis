import { TrueForge } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

import { createGoogleSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/googleSetup.js';

const SETUP = { mode: 'paste', client_type: 'desktop', redirect_uri: 'http://127.0.0.1:53682/callback' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function apiWith(fetchImpl: typeof fetch) {
  return createGoogleSetupApi(new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl }));
}

describe('createGoogleSetupApi', () => {
  it('reads the status from the user settings route and returns camelCase', async () => {
    const urls: string[] = [];
    const api = apiWith(async input => {
      urls.push(String(input));
      return reply({
        data: {
          state: 'not_connected',
          account_email: null,
          features: [],
          has_saved_client: false,
          available: true,
          setup: SETUP,
        },
      });
    });

    const status = await api.getGoogleStatus();
    expect(status.state).toBe('not_connected');
    expect(status.setup.redirectUri).toBe('http://127.0.0.1:53682/callback');
    expect(urls).toEqual(['http://harness.test/api/v1/user/settings/google/status']);
  });

  it('sends snake_case on the wire and omits the client to reuse the saved one', async () => {
    const sent: unknown[] = [];
    const api = apiWith(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return reply({ data: { authorization_url: 'https://accounts.example.test', setup: SETUP } }, 201);
    });

    await api.beginGoogleConsent({ client: null, features: ['gmail_compose'] });
    await api.beginGoogleConsent({
      client: { clientId: 'id', clientSecret: 'secret', clientType: 'desktop' },
      features: ['gmail_read'],
    });
    await api.beginGoogleConsent({
      client: { clientId: 'id', clientSecret: 'secret', clientType: null },
      features: ['gmail_read'],
    });

    expect(sent).toEqual([
      { features: ['gmail_compose'] },
      { client: { client_id: 'id', client_secret: 'secret', client_type: 'desktop' }, features: ['gmail_read'] },
      { client: { client_id: 'id', client_secret: 'secret' }, features: ['gmail_read'] },
    ]);
  });

  it('sends the whole pasted address', async () => {
    const sent: unknown[] = [];
    const api = apiWith(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return reply({
        data: {
          state: 'connected',
          account_email: 'ada@example.com',
          features: [],
          has_saved_client: true,
          available: true,
          setup: SETUP,
        },
      });
    });
    const status = await api.completeGoogleConsent({ address: 'http://127.0.0.1:53682/callback?state=s&code=c' });
    expect(sent).toEqual([{ address: 'http://127.0.0.1:53682/callback?state=s&code=c' }]);
    expect(status.accountEmail).toBe('ada@example.com');
  });

  it('sends a JSON content type on the bodiless test and disconnect calls', async () => {
    const contentTypes: (string | null)[] = [];
    const api = apiWith(async (input, init) => {
      contentTypes.push(new Headers(init?.headers).get('content-type'));
      return String(input).endsWith('/test')
        ? reply({ data: { result: 'ok', account_email: 'ada@example.com' } })
        : reply({ data: { revocation_confirmed: true } });
    });

    await api.testGoogleConnection();
    const disconnected = await api.disconnectGoogle();

    expect(contentTypes).toEqual(['application/json', 'application/json']);
    expect(disconnected.revocationConfirmed).toBe(true);
  });

  it('raises when the server refuses', async () => {
    const api = apiWith(async () => reply({ error: { message: 'That address has no code in it.' } }, 400));
    await expect(api.completeGoogleConsent({ address: 'x' })).rejects.toThrow();
  });
});
