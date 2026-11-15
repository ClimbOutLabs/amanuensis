/**
 * Terminal pairing in local sign-in mode, through the whole server app: Nora creates
 * her sign-in, pairs her terminal Pippa, and the key works on chats and nowhere else.
 * Changing her password revokes every paired key, as it signs out every other device.
 * Everyone here is made up.
 */
import { z } from 'zod';
import { ADDRESS_NOT_LISTED_MESSAGE } from '../../../src/auth/allowedOrigins';
import configuration from '../../../src/config';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const EMAIL = 'nora@example.test';
const PASSWORD = 'nora-password-1';
const NEW_PASSWORD = 'nora-password-2';
const ORIGIN = `http://localhost:${String(configuration.PORT)}`;
const BASE = `http://localhost:${String(configuration.PORT)}`;

const StartResponseSchema = z.object({
  data: z.object({
    pairing_id: z.string(),
    code: z.string(),
    confirm_url: z.string(),
    expires_at: z.string(),
  }),
});
const CompleteResponseSchema = z.object({
  data: z.object({
    status: z.enum(['waiting', 'paired']),
    terminal_key: z.string().optional(),
    device_name: z.string().optional(),
  }),
});

/** The id_token cookie pair from a response, for the next request's Cookie header. */
function sessionCookie(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map(header => header.split(';')[0] ?? '')
    .find(part => part.startsWith('id_token='));
  if (pair === undefined) {
    throw new Error('The response set no id_token cookie');
  }
  return pair;
}

async function createSignIn(server: ApprovalTestServer): Promise<string> {
  const created = await server.request(`${BASE}/api/v1/auth/create-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, password_confirm: PASSWORD }).toString(),
  });
  expect(created.status).toBe(302);
  return sessionCookie(created);
}

function postJson(body: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

async function pairTerminal(
  server: ApprovalTestServer,
  cookie: string,
  deviceName: string,
): Promise<{ key: string; keyId: string }> {
  const started = await server.request(`${BASE}/api/v1/terminal-pairings`, postJson({ device_name: deviceName }));
  expect(started.status).toBe(201);
  const start = StartResponseSchema.parse(await started.json());
  const confirmed = await server.request(
    `${BASE}/api/v1/terminal-pairings/confirm`,
    postJson({ code: start.data.code }, { Cookie: cookie }),
  );
  expect(confirmed.status).toBe(200);
  const completed = await server.request(
    `${BASE}/api/v1/terminal-pairings/complete`,
    postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
  );
  expect(completed.status).toBe(200);
  const completion = CompleteResponseSchema.parse(await completed.json());
  if (completion.data.status !== 'paired' || completion.data.terminal_key === undefined) {
    throw new Error('the pairing did not hand over a key');
  }
  const rows = await server
    .db()
    .selectFrom('terminal_key')
    .select(['id', 'device_name'])
    .where('device_name', '=', deviceName)
    .execute();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('the pairing stored no key row');
  }
  return { key: completion.data.terminal_key, keyId: row.id };
}

describe('terminal pairing with local sign-in', () => {
  let server: ApprovalTestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('pairs a terminal end to end, and the start is in the audit log at once', async () => {
    server = await startApprovalTestServer({ localSignIn: true });
    const cookie = await createSignIn(server);
    const { key } = await pairTerminal(server, cookie, 'Pippa');

    const chats = await server.request(`${BASE}/api/v1/sessions`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(chats.status).toBe(200);

    // Local sign-in can name its one owner before anyone signs in, so the start
    // itself is recorded, beside the confirm.
    const audit = await server
      .db()
      .selectFrom('sentinel_audit')
      .select(['tool_name', 'description'])
      .where('tool_name', 'like', 'terminal%')
      .execute();
    expect(audit.map(row => row.tool_name).sort()).toEqual(['terminal_pairing.confirmed', 'terminal_pairing.started']);
    expect(JSON.stringify(audit)).not.toContain(key);
  }, 120_000);

  it('refuses the key on settings, on the account routes and on a browser-only route', async () => {
    server = await startApprovalTestServer({ localSignIn: true });
    const cookie = await createSignIn(server);
    const { key } = await pairTerminal(server, cookie, 'Pippa');
    const bearer = { Authorization: `Bearer ${key}` };

    const settings = await server.request(`${BASE}/api/v1/settings/model-providers`, { headers: bearer });
    expect(settings.status).toBe(403);
    const keyList = await server.request(`${BASE}/api/v1/settings/terminal-keys`, { headers: bearer });
    expect(keyList.status).toBe(403);
    const me = await server.request(`${BASE}/api/v1/auth/me`, { headers: bearer });
    expect(me.status).toBe(403);
    const maps = await server.request(`${BASE}/api/maps/tiles/1/2/3`, { headers: bearer });
    expect(maps.status).toBe(401);
    expect(await maps.text()).toContain('A browser session is required');
  }, 120_000);

  it('changing the password revokes every paired terminal key', async () => {
    server = await startApprovalTestServer({ localSignIn: true });
    const cookie = await createSignIn(server);
    const pippa = await pairTerminal(server, cookie, 'Pippa');
    const pippaTwo = await pairTerminal(server, cookie, 'Pippa Two');
    for (const paired of [pippa, pippaTwo]) {
      const chats = await server.request(`${BASE}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${paired.key}` },
      });
      expect(chats.status).toBe(200);
    }

    const changed = await server.request(
      `${BASE}/api/v1/auth/change-password`,
      postJson({ current_password: PASSWORD, new_password: NEW_PASSWORD }, { Cookie: cookie }),
    );
    expect(changed.status).toBe(204);

    for (const paired of [pippa, pippaTwo]) {
      const chats = await server.request(`${BASE}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${paired.key}` },
      });
      expect(chats.status).toBe(401);
    }
    const rows = await server.db().selectFrom('terminal_key').select(['revoked_at']).execute();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.revoked_at !== null)).toBe(true);
    const audit = await server
      .db()
      .selectFrom('sentinel_audit')
      .select(['tool_name'])
      .where('tool_name', '=', 'terminal_key.revoked_all')
      .execute();
    expect(audit).toHaveLength(1);
  }, 120_000);

  it('stores only the hash of the key in the database', async () => {
    server = await startApprovalTestServer({ localSignIn: true });
    const cookie = await createSignIn(server);
    const { key } = await pairTerminal(server, cookie, 'Pippa');
    const rows = await server.db().selectFrom('terminal_key').selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('no terminal key row was stored');
    }
    expect(row.key_hash).not.toBe(key);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.device_name).toBe('Pippa');
    expect(row.subject_display_name).toBe(EMAIL);
  }, 120_000);
});

describe('terminal pairing under the address rules', () => {
  let server: ApprovalTestServer | undefined;
  const originalAllowedOrigins = configuration.ALLOWED_ORIGINS;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    configuration.ALLOWED_ORIGINS = originalAllowedOrigins;
  });

  it('refuses a pairing start from an unlisted address with the same message a browser gets', async () => {
    configuration.ALLOWED_ORIGINS = ['http://192.168.0.214:8790'];
    server = await startApprovalTestServer({ localSignIn: true });

    // The Host header is named outright, as every real client sends it; the in-memory
    // harness would otherwise send none and the guard would skip its address check.
    const refused = await server.request('http://evil.example.com/api/v1/terminal-pairings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com', Host: 'evil.example.com' },
      body: JSON.stringify({ device_name: 'Pippa' }),
    });
    expect(refused.status).toBe(421);
    expect(await refused.text()).toBe(ADDRESS_NOT_LISTED_MESSAGE);

    const listed = await server.request('http://192.168.0.214:8790/api/v1/terminal-pairings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://192.168.0.214:8790',
        Host: '192.168.0.214:8790',
      },
      body: JSON.stringify({ device_name: 'Pippa' }),
    });
    expect(listed.status).toBe(201);
  }, 120_000);
});
