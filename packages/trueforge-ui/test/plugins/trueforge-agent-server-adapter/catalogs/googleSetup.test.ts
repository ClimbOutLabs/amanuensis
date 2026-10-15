import { describe, expect, it, vi } from 'vitest';

import { createGoogleSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/googleSetup.js';

const SETUP = { mode: 'paste', client_type: 'desktop', redirect_uri: 'http://127.0.0.1:53682/callback' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createGoogleSetupApi', () => {
  it('reads the status from the user settings route', async () => {
    const fetchSpy = vi.fn(async () =>
      reply({
        data: { state: 'not_connected', account_email: null, features: [], has_saved_client: false, setup: SETUP },
      }),
    );
    const api = createGoogleSetupApi({ baseUrl: 'https://aman.example.org/', fetch: fetchSpy });

    expect((await api.getGoogleStatus()).state).toBe('not_connected');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://aman.example.org/api/v1/user/settings/google/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends snake_case on the wire and null to reuse the saved client', async () => {
    const sent: unknown[] = [];
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return reply({ data: { authorization_url: 'https://accounts.example.test', setup: SETUP } });
    });
    const api = createGoogleSetupApi({ fetch: fetchSpy });

    await api.beginGoogleConsent({ client: null, features: ['gmail_compose'] });
    await api.beginGoogleConsent({
      client: { clientId: 'id', clientSecret: 'secret', clientType: 'desktop' },
      features: ['gmail_read'],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = sent;
    expect(bodies[0]).toEqual({ client: null, features: ['gmail_compose'] });
    expect(bodies[1]).toEqual({
      client: { client_id: 'id', client_secret: 'secret', client_type: 'desktop' },
      features: ['gmail_read'],
    });
  });

  it('raises the server message when a request fails', async () => {
    const api = createGoogleSetupApi({
      fetch: async () => reply({ error: { message: 'That address has no code in it.' } }, 400),
    });
    await expect(api.completeGoogleConsent({ address: 'x' })).rejects.toThrow('That address has no code in it.');
  });

  it('refuses a body that does not have the expected shape', async () => {
    const api = createGoogleSetupApi({ fetch: async () => reply({ data: { state: 'surprise' } }) });
    await expect(api.getGoogleStatus()).rejects.toThrow('unreadable');
  });
});
