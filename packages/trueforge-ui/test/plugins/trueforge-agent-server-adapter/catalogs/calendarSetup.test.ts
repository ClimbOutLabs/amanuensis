import { describe, expect, it } from 'vitest';

import { createCalendarSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/calendarSetup.js';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

const STATUS_BODY = {
  data: {
    available: true,
    state: 'connected',
    email: 'owner@example.invalid',
    username: 'owner-login',
    calendar_url: 'https://caldav.fastmail.com/dav/',
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
    expect(status.username).toBe('owner-login');
    expect(status.calendarUrl).toBe('https://caldav.fastmail.com/dav/');
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
      reply({ data: { ...STATUS_BODY.data, state: 'not_connected', email: null, username: null, calendar_url: null } }),
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

  it('a reply of the wrong shape is dropped, not trusted, and the person gets a plain line', async () => {
    const { api } = apiWith(async () => reply({ data: { password: CANARY } }));
    const failure = await api.getCalendarStatus().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toBe(
      'The server answered in a way this page cannot read. Reload the page, then try again.',
    );
    expect(failure instanceof Error ? failure.message : '').not.toContain(CANARY);
  });

  it('reads the not working state', async () => {
    const { api } = apiWith(async () => reply({ data: { ...STATUS_BODY.data, state: 'not_working' } }));
    expect((await api.getCalendarStatus()).state).toBe('not_working');
  });

  it('never shows technical text: a dropped connection, a missing session, a member, a crash and a bare error', async () => {
    const cases: { make: () => Promise<Response>; says: string }[] = [
      {
        make: () => Promise.reject(new TypeError('Failed to fetch')),
        says: "Couldn't reach the server. Check your internet connection and try again.",
      },
      {
        make: async () => reply({ error: { message: 'Authentication required' } }, 401),
        says: 'You are signed out. Sign in again, then try again.',
      },
      {
        make: async () => reply({ error: { message: 'Admin access required' } }, 403),
        says: 'Only the owner can change this. Sign in as the owner, then try again.',
      },
      {
        make: async () => reply({ error: { message: 'TypeError: x is not a function at foo.ts:1' } }, 500),
        says: 'Something went wrong on the server. Wait a minute, then try again.',
      },
      {
        make: async () => new Response('<html>Bad gateway</html>', { status: 404 }),
        says: 'That did not work. Try again.',
      },
    ];
    for (const { make, says } of cases) {
      const { api } = apiWith(make);
      const failure = await api.getCalendarStatus().catch((caught: unknown) => caught);
      expect(failure instanceof Error ? failure.message : '').toBe(says);
      expect(failure instanceof Error ? failure.message : '').not.toMatch(/HTTP|Failed to fetch|payload|TypeError/);
    }
  });

  it('keeps the original failure as the cause of the plain line', async () => {
    const original = new TypeError('Failed to fetch');
    const { api } = apiWith(() => Promise.reject(original));
    const failure = await api.getCalendarStatus().catch((caught: unknown) => caught);
    expect(failure instanceof Error ? failure.cause : undefined).toBe(original);
  });
});
