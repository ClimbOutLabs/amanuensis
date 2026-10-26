import { describe, expect, it } from 'vitest';

import { createCalendarSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/calendarSetup.js';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

const STATUS_BODY = {
  data: {
    available: true,
    state: 'connected',
    email: 'owner@example.invalid',
    provider_key: 'fastmail',
    providers: [
      {
        key: 'fastmail',
        name: 'Fastmail',
        server_url: 'https://caldav.fastmail.com/dav/',
        help_url: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
        help_hint: 'Fastmail: make an app password.',
      },
      { key: 'other', name: 'Other', server_url: null, help_url: null, help_hint: 'Ask your provider.' },
    ],
  },
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Seen = {
  url: string;
  method: string;
  body: string | undefined;
  credentials: string | undefined;
  headers: unknown;
};

function apiWith(handler: (seen: Seen) => Promise<Response>) {
  const seen: Seen[] = [];
  const api = createCalendarSetupApi({
    baseUrl: 'http://harness.test',
    fetch: async (input, init) => {
      const entry: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        credentials: init?.credentials,
        headers: init?.headers,
      };
      seen.push(entry);
      return handler(entry);
    },
  });
  return { api, seen };
}

describe('createCalendarSetupApi', () => {
  it('reads the status and maps it to camelCase', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY));
    const status = await api.getCalendarStatus();
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/calendar/status');
    expect(status.providerKey).toBe('fastmail');
    expect(status.email).toBe('owner@example.invalid');
    expect(status.providers[0]?.serverUrl).toBe('https://caldav.fastmail.com/dav/');
    expect(status.providers[0]?.helpUrl).toContain('fastmail.help');
    expect(status.providers[1]?.helpUrl).toBeNull();
  });

  it('saves with snake_case on the wire, the session cookie, and no bearer header', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY, 201));
    await api.saveCalendarAccount({
      providerKey: 'other',
      email: 'owner@example.invalid',
      password: CANARY,
      username: 'owner-login',
      calendarUrl: 'https://nas.example.invalid/dav/',
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/calendar');
    expect(seen[0]?.credentials).toBe('same-origin');
    expect(JSON.stringify(seen[0]?.headers)).not.toContain('Authorization');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      provider_key: 'other',
      email: 'owner@example.invalid',
      password: CANARY,
      username: 'owner-login',
      calendar_url: 'https://nas.example.invalid/dav/',
    });
  });

  it('leaves out the login name and the address when they were not typed', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY, 201));
    await api.saveCalendarAccount({ providerKey: 'fastmail', email: 'owner@example.invalid', password: CANARY });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      provider_key: 'fastmail',
      email: 'owner@example.invalid',
      password: CANARY,
    });
  });

  it('remove sends a JSON body, so the call is not refused as foreign', async () => {
    const { api, seen } = apiWith(async () =>
      reply({ data: { ...STATUS_BODY.data, state: 'not_connected', email: null } }),
    );
    const status = await api.removeCalendarAccount();
    expect(status.state).toBe('not_connected');
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.body).toBe('{}');
    expect(JSON.stringify(seen[0]?.headers)).toContain('application/json');
  });

  it('passes the server plain error line through, and nothing else', async () => {
    const { api } = apiWith(async () =>
      reply(
        {
          error: {
            message: 'That login was refused. Make a new app password and try again.',
            type: 'sign_in_refused',
            debug: CANARY,
          },
        },
        400,
      ),
    );
    await expect(
      api.saveCalendarAccount({ providerKey: 'fastmail', email: 'owner@example.invalid', password: CANARY }),
    ).rejects.toThrow('That login was refused. Make a new app password and try again.');
  });

  it('a reply of the wrong shape is dropped, not trusted', async () => {
    const { api } = apiWith(async () => reply({ data: { password: CANARY } }));
    await expect(api.getCalendarStatus()).rejects.toThrow('unexpected calendar payload');
  });
});
