import { describe, expect, it } from 'vitest';

import { createEmailSetupApi } from '@/plugins/trueforge-agent-server-adapter/catalogs/emailSetup.js';

const CANARY = 'CANARY-APP-PASSWORD-7f3d9';

const STATUS_BODY = {
  data: {
    available: true,
    state: 'connected',
    address: 'person@gmail.com',
    provider_key: 'gmail',
    providers: [
      {
        key: 'gmail',
        name: 'Gmail',
        imap_host: 'imap.gmail.com',
        imap_port: 993,
        imap_mode: 'ssl',
        smtp_host: 'smtp.gmail.com',
        smtp_port: 465,
        smtp_mode: 'ssl',
        help_url: 'https://support.google.com/accounts/answer/185833',
        help_hint: 'Turn on two-step verification, then make an app password for Mail.',
      },
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
  const api = createEmailSetupApi({
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

describe('createEmailSetupApi', () => {
  it('reads the status and maps it to camelCase', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY));
    const status = await api.getEmailStatus();
    expect(seen[0]?.url).toBe('http://harness.test/api/v1/user/settings/email/status');
    expect(status.providerKey).toBe('gmail');
    expect(status.providers[0]?.imapHost).toBe('imap.gmail.com');
    expect(status.providers[0]?.helpUrl).toBe('https://support.google.com/accounts/answer/185833');
  });

  it('saves with snake_case on the wire, the session cookie, and no bearer header', async () => {
    const { api, seen } = apiWith(async () => reply(STATUS_BODY, 201));
    await api.saveEmailAccount({ providerKey: 'gmail', address: 'person@gmail.com', password: CANARY });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.credentials).toBe('same-origin');
    expect(JSON.stringify(seen[0]?.headers)).not.toContain('Authorization');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      provider_key: 'gmail',
      address: 'person@gmail.com',
      password: CANARY,
    });
  });

  it('remove sends a JSON body, so the call is not refused as foreign', async () => {
    const { api, seen } = apiWith(async () =>
      reply({ data: { ...STATUS_BODY.data, state: 'not_connected', address: null } }),
    );
    const status = await api.removeEmailAccount();
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
            message: 'That password was refused. Make a new app password and try again.',
            type: 'sign_in_refused',
            debug: CANARY,
          },
        },
        400,
      ),
    );
    await expect(
      api.saveEmailAccount({ providerKey: 'gmail', address: 'person@gmail.com', password: CANARY }),
    ).rejects.toThrow('That password was refused. Make a new app password and try again.');
  });

  it('a reply of the wrong shape is dropped, not trusted', async () => {
    const { api } = apiWith(async () => reply({ data: { password: CANARY } }));
    await expect(api.getEmailStatus()).rejects.toThrow(
      'The server answered in a way this page cannot read. Reload the page, then try again.',
    );
  });
});
