/**
 * Terminal pairing in the sign-in service mode (OIDC): the whole flow over the real
 * pairing router, the real authenticator and the real auth middleware, with stub
 * routes standing in for the chat side, an admin route and a browser-only route.
 * Everyone here is made up: Nora owns the instance and Pippa is her terminal.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createTerminalKeysRouter } from '../../../src/apis/terminalKeys';
import { createTerminalPairingRouter } from '../../../src/apis/terminalPairings';
import { resolveRequestContext } from '../../../src/auth/identity';
import { LoginAttemptLimiter } from '../../../src/auth/loginRateLimit';
import {
  createAdminAuthMiddleware,
  createAuthMiddleware,
  createUiSessionAuthMiddleware,
} from '../../../src/auth/middleware';
import { disableOidcAuth, enableOidcAuth, initOidc } from '../../../src/auth/oidc';
import { OidcAuthenticator } from '../../../src/auth/oidcAuthenticator';
import { TERMINAL_KEY_PREFIX } from '../../../src/auth/terminalKey';
import type { OIDCConfig } from '../../../src/config';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { TerminalKeyStore } from '../../../src/db/terminalKeyStore';
import { TerminalPairingService } from '../../../src/runtime/terminalPairing';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'harness-client';

const OIDC_CONFIG: OIDCConfig = {
  OIDC_ISSUER_URL: `${ISSUER}/`,
  OIDC_CLIENT_ID: AUDIENCE,
  OIDC_CLIENT_SECRET: 'harness-secret',
  OIDC_USER_REFERENCE_CLAIM: 'sub',
  OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
  OIDC_USER_ROLE_CLAIM: 'groups',
  OIDC_ADMIN_ROLE_VALUE: 'admin',
  OIDC_SCOPES: ['openid', 'profile', 'email', 'groups'],
  OIDC_ALLOWED_EMAILS: [],
  OIDC_REQUIRE_VERIFIED_EMAIL: false,
};

const StartResponseSchema = z.object({
  data: z.object({
    pairing_id: z.string(),
    code: z.string(),
    confirm_url: z.string(),
    expires_at: z.string(),
  }),
});
const ConfirmResponseSchema = z.object({
  data: z.object({ device_name: z.string(), paired_at: z.string() }),
});
const CompleteResponseSchema = z.object({
  data: z.object({
    status: z.enum(['waiting', 'paired']),
    terminal_key: z.string().optional(),
    device_name: z.string().optional(),
  }),
});
const ListKeysResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      device_name: z.string(),
      paired_at: z.string(),
      last_used_at: z.string(),
      revoked_at: z.string().nullable(),
    }),
  ),
});
const ErrorResponseSchema = z.object({ error: z.object({ message: z.string() }) });

type SqliteDb = ReturnType<typeof createSqliteDb>;

interface Harness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  db: SqliteDb;
  terminalKeyStore: TerminalKeyStore;
  auditRows: () => Promise<{ tool_name: string; description: string; created_by: string }[]>;
  noraToken: () => Promise<string>;
}

async function jsonBody(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

describe('terminal pairing with the sign-in service', () => {
  const realFetch = globalThis.fetch;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let oidcClient: Awaited<ReturnType<typeof initOidc>>;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = 'test-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    globalThis.fetch = async input => {
      const url = String(input);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            subject_types_supported: ['public'],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === `${ISSUER}/jwks`) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(`unexpected url: ${url}`, { status: 404 });
    };

    oidcClient = await initOidc(OIDC_CONFIG);
    if (!oidcClient) {
      throw new Error('OIDC client was not initialized');
    }
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    disableOidcAuth();
  });

  beforeEach(() => {
    if (!oidcClient) {
      throw new Error('OIDC client was not initialized');
    }
    enableOidcAuth({ client: oidcClient, oidcConfig: OIDC_CONFIG });
  });

  async function noraToken(): Promise<string> {
    return new SignJWT({ groups: ['admin'], name: 'Nora' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('nora')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  async function buildHarness(options?: {
    limiter?: LoginAttemptLimiter;
    pairingService?: (store: TerminalKeyStore) => TerminalPairingService;
  }): Promise<Harness> {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const terminalKeyStore = new TerminalKeyStore(db);
    const auditStore = new SentinelAuditStore(db);
    const logger = createLogger({ silent: true });
    const authenticator = new OidcAuthenticator({ terminalKeyStore });
    const authMiddleware = createAuthMiddleware(authenticator);

    const app = new OpenAPIHono();
    app.onError((error, c) => {
      if (error instanceof HTTPException) {
        return c.json({ error: { message: error.message } }, error.status);
      }
      throw error;
    });
    app.route(
      '/api/v1/terminal-pairings',
      createTerminalPairingRouter({
        terminalKeyStore,
        audit: auditStore,
        logger,
        authMiddleware,
        ...(options?.limiter === undefined ? {} : { limiter: options.limiter }),
        ...(options?.pairingService === undefined ? {} : { pairingService: options.pairingService(terminalKeyStore) }),
      }),
    );
    // The chat side, standing in for the sessions router: echoes who the caller is.
    const sessions = new OpenAPIHono();
    sessions.use('*', authMiddleware);
    sessions.get('/', c => {
      const context = resolveRequestContext(c);
      return c.json({
        data: { subject_id: context.subject.id, terminal_key_id: context.terminal_key_id ?? null },
      });
    });
    // The session repository routes and the sandbox file download, at their real
    // shapes under the sessions prefix: chat-adjacent, but not chat scope.
    sessions.put('/:session_id/repository', c => c.json({ data: { bound: true } }));
    sessions.delete('/:session_id/repository', c => c.json({ data: { bound: false } }));
    sessions.post('/:session_id/repository/start-work', c => c.json({ data: { started: true } }));
    sessions.get('/:session_id/turns/:turn_id/download-sandbox-file', c => c.json({ data: { file: true } }));
    app.route('/api/v1/sessions', sessions);
    // A signed-in route outside the chat scope.
    const models = new OpenAPIHono();
    models.use('*', authMiddleware);
    models.get('/', c => c.json({ data: [] }));
    app.route('/api/v1/models', models);
    // Settings: the real terminal keys router beside a plain admin stub.
    const settings = new OpenAPIHono();
    settings.use('*', createAdminAuthMiddleware(authenticator));
    settings.route(
      '/terminal-keys',
      createTerminalKeysRouter({
        terminalKeyStore,
        audit: auditStore,
        logger,
        resolveRequestContext,
      }),
    );
    settings.get('/other', c => c.json({ ok: true }));
    app.route('/api/v1/settings', settings);
    // A browser-only route, like the map tile proxy.
    const maps = new OpenAPIHono();
    maps.use('*', createUiSessionAuthMiddleware(authenticator));
    maps.get('/tiles', c => c.json({ ok: true }));
    app.route('/api/maps', maps);

    return {
      request: async (path, init) => app.request(path, init),
      db,
      terminalKeyStore,
      auditRows: async () =>
        db
          .selectFrom('sentinel_audit')
          .select(['tool_name', 'description', 'created_by'])
          .orderBy('created_at')
          .execute(),
      noraToken,
    };
  }

  function postJson(body: unknown, headers?: Record<string, string>): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    };
  }

  async function pairPippa(harness: Harness): Promise<{ key: string; keyId: string }> {
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(started.status).toBe(201);
    const start = StartResponseSchema.parse(await jsonBody(started));
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);
    const completed = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(completed.status).toBe(200);
    const completion = CompleteResponseSchema.parse(await jsonBody(completed));
    if (completion.data.status !== 'paired' || completion.data.terminal_key === undefined) {
      throw new Error('the pairing did not hand over a key');
    }
    const key = completion.data.terminal_key;
    const listed = await harness.request('/api/v1/settings/terminal-keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const keys = ListKeysResponseSchema.parse(await jsonBody(listed));
    const row = keys.data.find(entry => entry.device_name === 'Pippa');
    if (row === undefined) {
      throw new Error('the paired key is not in the Settings list');
    }
    return { key, keyId: row.id };
  }

  it('pairs a terminal end to end and the key signs chat requests as the person who confirmed', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();

    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(started.status).toBe(201);
    const start = StartResponseSchema.parse(await jsonBody(started));
    expect(start.data.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(start.data.confirm_url).toContain(`pair-terminal?code=${encodeURIComponent(start.data.code)}`);
    expect(Date.parse(start.data.expires_at)).toBeGreaterThan(Date.now());

    // Before anyone confirms, the terminal waits.
    const waiting = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(waiting.status).toBe(200);
    expect(CompleteResponseSchema.parse(await jsonBody(waiting)).data.status).toBe('waiting');

    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);
    expect(ConfirmResponseSchema.parse(await jsonBody(confirmed)).data.device_name).toBe('Pippa');

    const completed = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    const completion = CompleteResponseSchema.parse(await jsonBody(completed));
    expect(completion.data.status).toBe('paired');
    const key = completion.data.terminal_key;
    if (key === undefined) {
      throw new Error('the completion carried no key');
    }
    expect(key.startsWith(TERMINAL_KEY_PREFIX)).toBe(true);

    const chat = await harness.request('/api/v1/sessions', { headers: { Authorization: `Bearer ${key}` } });
    expect(chat.status).toBe(200);
    const chatBody = z
      .object({ data: z.object({ subject_id: z.string(), terminal_key_id: z.string().nullable() }) })
      .parse(await jsonBody(chat));
    expect(chatBody.data.subject_id).toBe('nora');
    expect(chatBody.data.terminal_key_id).not.toBeNull();

    // The start and the confirm both reached the audit log under Nora.
    const audit = await harness.auditRows();
    expect(audit.map(row => row.tool_name).sort()).toEqual(['terminal_pairing.confirmed', 'terminal_pairing.started']);
    expect(audit.every(row => row.created_by === 'nora')).toBe(true);
    expect(audit.some(row => row.description.includes('Pippa'))).toBe(true);
  });

  it('refuses a wrong code at confirm and a wrong code at completion', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));

    const wrongConfirm = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: 'ZZZZ-ZZZZ' }, { Authorization: `Bearer ${token}` }),
    );
    expect(wrongConfirm.status).toBe(404);

    const wrongComplete = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: 'ZZZZ-ZZZZ' }),
    );
    expect(wrongComplete.status).toBe(404);

    // The real code still works afterwards: a wrong guess does not burn the pairing.
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);
  });

  it('refuses a code that was already used and a key that was already claimed', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));
    await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    const first = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(first.status).toBe(200);

    const confirmAgain = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmAgain.status).toBe(404);
    const completeAgain = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(completeAgain.status).toBe(404);
  });

  it('expires a code a few minutes after it is issued', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const harness = await buildHarness({
      pairingService: store => new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs }),
    });
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));

    nowMs += 6 * 60_000;
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(404);
    const completed = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(completed.status).toBe(404);
  });

  it('rate limits pairing starts the way the sign-in form limits its page', async () => {
    const harness = await buildHarness({ limiter: new LoginAttemptLimiter({ maxPageStartsPerMinute: 2 }) });
    const first = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const second = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const third = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).not.toBeNull();
    expect(ErrorResponseSchema.parse(await jsonBody(third)).error.message).toContain('Too many sign-in attempts');
  });

  it('rate limits pairing confirms the way the sign-in form limits password guesses', async () => {
    const harness = await buildHarness({
      limiter: new LoginAttemptLimiter({ maxFailuresPerKey: 2, maxFailuresPerAccount: 100 }),
    });
    const token = await harness.noraToken();
    const attempt = async () =>
      harness.request(
        '/api/v1/terminal-pairings/confirm',
        postJson({ code: 'ZZZZ-ZZZZ' }, { Authorization: `Bearer ${token}` }),
      );
    expect((await attempt()).status).toBe(404);
    expect((await attempt()).status).toBe(404);
    expect((await attempt()).status).toBe(429);
  });

  it('lists the key in Settings without the key or its hash, and a revoke there stops the key at once', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const { key, keyId } = await pairPippa(harness);

    const listed = await harness.request('/api/v1/settings/terminal-keys', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    const listedText = await listed.clone().text();
    expect(listedText).not.toContain(key);
    const stored = await harness.terminalKeyStore.listForOwner({ tenant_id: 'default', subject_id: 'nora' });
    expect(stored).toHaveLength(1);
    expect(listedText).not.toContain(stored[0]?.key_hash ?? 'no-hash');

    const before = await harness.request('/api/v1/sessions', { headers: { Authorization: `Bearer ${key}` } });
    expect(before.status).toBe(200);
    const revoked = await harness.request(`/api/v1/settings/terminal-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(200);
    const after = await harness.request('/api/v1/sessions', { headers: { Authorization: `Bearer ${key}` } });
    expect(after.status).toBe(401);

    const audit = await harness.auditRows();
    expect(audit.map(row => row.tool_name)).toContain('terminal_key.revoked');
  });

  it('lets a terminal revoke its own key, which then stops working', async () => {
    const harness = await buildHarness();
    const { key } = await pairPippa(harness);
    const revoked = await harness.request(
      '/api/v1/terminal-pairings/revoke-current',
      postJson({}, { Authorization: `Bearer ${key}` }),
    );
    expect(revoked.status).toBe(200);
    const after = await harness.request('/api/v1/sessions', { headers: { Authorization: `Bearer ${key}` } });
    expect(after.status).toBe(401);
    const audit = await harness.auditRows();
    expect(audit.map(row => row.tool_name)).toContain('terminal_key.revoked');
  });

  it('refuses a terminal key on admin and settings routes', async () => {
    const harness = await buildHarness();
    const { key } = await pairPippa(harness);
    const admin = await harness.request('/api/v1/settings/other', { headers: { Authorization: `Bearer ${key}` } });
    expect(admin.status).toBe(403);
    const list = await harness.request('/api/v1/settings/terminal-keys', {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(list.status).toBe(403);
  });

  it('refuses a terminal key on the repository routes and the sandbox file download under sessions', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const { key } = await pairPippa(harness);
    const refused: [string, RequestInit][] = [
      ['/api/v1/sessions/sess-1/repository', { method: 'PUT' }],
      ['/api/v1/sessions/sess-1/repository', { method: 'DELETE' }],
      ['/api/v1/sessions/sess-1/repository/start-work', { method: 'POST' }],
      ['/api/v1/sessions/sess-1/turns/turn-1/download-sandbox-file', { method: 'GET' }],
    ];
    for (const [path, init] of refused) {
      const withKey = await harness.request(path, {
        ...init,
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(withKey.status).toBe(403);
      expect(ErrorResponseSchema.parse(await jsonBody(withKey)).error.message).toContain('can only reach chats');
      // The same routes answer a normal sign-in: the refusal is the terminal scope, not the route.
      const withToken = await harness.request(path, {
        ...init,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(withToken.status).toBe(200);
    }
  });

  it('revokes the stored key when a confirmed pairing lapses before the terminal collects it', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const harness = await buildHarness({
      pairingService: store => new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs }),
    });
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);

    nowMs += 6 * 60_000;
    const completed = await harness.request(
      '/api/v1/terminal-pairings/complete',
      postJson({ pairing_id: start.data.pairing_id, code: start.data.code }),
    );
    expect(completed.status).toBe(404);

    const stored = await harness.terminalKeyStore.listForOwner({ tenant_id: 'default', subject_id: 'nora' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.revoked_at).not.toBeNull();
  });

  it('refuses a terminal key on a browser-only route', async () => {
    const harness = await buildHarness();
    const { key } = await pairPippa(harness);
    const tiles = await harness.request('/api/maps/tiles', { headers: { Authorization: `Bearer ${key}` } });
    expect(tiles.status).toBe(401);
    expect(ErrorResponseSchema.parse(await jsonBody(tiles)).error.message).toBe('A browser session is required');
  });

  it('refuses a terminal key on a signed-in route outside the chat scope', async () => {
    const harness = await buildHarness();
    const { key } = await pairPippa(harness);
    const models = await harness.request('/api/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    expect(models.status).toBe(403);
    expect(ErrorResponseSchema.parse(await jsonBody(models)).error.message).toContain('can only reach chats');
  });

  it('refuses an unknown terminal key and a terminal key that tries to confirm a pairing', async () => {
    const harness = await buildHarness();
    const unknown = await harness.request('/api/v1/sessions', {
      headers: { Authorization: `Bearer ${TERMINAL_KEY_PREFIX}unknown-key-that-was-never-paired` },
    });
    expect(unknown.status).toBe(401);

    const { key } = await pairPippa(harness);
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa Two' }));
    const start = StartResponseSchema.parse(await jsonBody(started));
    const confirm = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${key}` }),
    );
    expect(confirm.status).toBe(403);
  });

  it('stores only the hash of the key, never the key itself', async () => {
    const harness = await buildHarness();
    const { key } = await pairPippa(harness);
    const rows = await harness.db.selectFrom('terminal_key').selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('no terminal key row was stored');
    }
    expect(row.key_hash).not.toBe(key);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.device_name).toBe('Pippa');
    expect(row.revoked_at).toBeNull();
    const audit = await harness.auditRows();
    expect(JSON.stringify(audit)).not.toContain(key);
  });

  it('updates the last-used time when the key signs a request', async () => {
    const harness = await buildHarness();
    const { key, keyId } = await pairPippa(harness);
    await harness.db
      .updateTable('terminal_key')
      .set({ last_used_at: '2000-01-01T00:00:00.000Z' })
      .where('id', '=', keyId)
      .execute();
    const chat = await harness.request('/api/v1/sessions', { headers: { Authorization: `Bearer ${key}` } });
    expect(chat.status).toBe(200);
    const row = await harness.db
      .selectFrom('terminal_key')
      .select('last_used_at')
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow();
    const lastUsed = typeof row.last_used_at === 'string' ? row.last_used_at : row.last_used_at.toISOString();
    expect(lastUsed > '2000-01-01T00:00:00.000Z').toBe(true);
  });

  it('shows the waiting terminal name to the signed-in person before they confirm', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    expect(started.status).toBe(201);
    const start = StartResponseSchema.parse(await jsonBody(started));

    const lookedUp = await harness.request(
      '/api/v1/terminal-pairings/lookup',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(lookedUp.status).toBe(200);
    expect(await jsonBody(lookedUp)).toEqual({ data: { device_name: 'Pippa' } });

    // The lookup only reads: the pairing is still there to confirm afterwards.
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);
  });

  it('answers a wrong code at lookup with the same refusal confirm gives', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();

    const lookedUp = await harness.request(
      '/api/v1/terminal-pairings/lookup',
      postJson({ code: 'ZZZZ-ZZZZ' }, { Authorization: `Bearer ${token}` }),
    );
    expect(lookedUp.status).toBe(404);
    const lookupRefusal = ErrorResponseSchema.parse(await jsonBody(lookedUp));

    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: 'ZZZZ-ZZZZ' }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(404);
    const confirmRefusal = ErrorResponseSchema.parse(await jsonBody(confirmed));
    expect(lookupRefusal).toEqual(confirmRefusal);
  });

  it('answers a used code at lookup with the same refusal', async () => {
    const harness = await buildHarness();
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));
    const confirmed = await harness.request(
      '/api/v1/terminal-pairings/confirm',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(confirmed.status).toBe(200);

    const lookedUp = await harness.request(
      '/api/v1/terminal-pairings/lookup',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(lookedUp.status).toBe(404);
    const refusal = ErrorResponseSchema.parse(await jsonBody(lookedUp));
    expect(refusal.error.message).toContain('not right, or it has expired');
  });

  it('answers an expired code at lookup with the same refusal', async () => {
    let nowMs = Date.parse('2026-11-15T10:00:00.000Z');
    const harness = await buildHarness({
      pairingService: store => new TerminalPairingService({ terminalKeyStore: store, now: () => nowMs }),
    });
    const token = await harness.noraToken();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));

    nowMs += 6 * 60_000;
    const lookedUp = await harness.request(
      '/api/v1/terminal-pairings/lookup',
      postJson({ code: start.data.code }, { Authorization: `Bearer ${token}` }),
    );
    expect(lookedUp.status).toBe(404);
    const refusal = ErrorResponseSchema.parse(await jsonBody(lookedUp));
    expect(refusal.error.message).toContain('not right, or it has expired');
  });

  it('refuses a lookup with no sign-in', async () => {
    const harness = await buildHarness();
    const started = await harness.request('/api/v1/terminal-pairings', postJson({ device_name: 'Pippa' }));
    const start = StartResponseSchema.parse(await jsonBody(started));

    const lookedUp = await harness.request('/api/v1/terminal-pairings/lookup', postJson({ code: start.data.code }));
    expect(lookedUp.status).toBe(401);
  });
});

describe('terminal key store', () => {
  it('revokes every live key of one owner and no key of another', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new TerminalKeyStore(db);
    const base = {
      tenant_id: 'default',
      subject_type: 'user',
      subject_display_name: 'Nora',
      created_at: '2026-11-15T10:00:00.000Z',
      last_used_at: '2026-11-15T10:00:00.000Z',
      revoked_at: null,
    };
    await store.create({ ...base, id: 'k1', subject_id: 'nora', device_name: 'Pippa', key_hash: 'a'.repeat(64) });
    await store.create({ ...base, id: 'k2', subject_id: 'nora', device_name: 'Pippa Two', key_hash: 'b'.repeat(64) });
    await store.create({ ...base, id: 'k3', subject_id: 'wendy', device_name: 'Pippa', key_hash: 'c'.repeat(64) });
    await store.revoke({
      tenant_id: 'default',
      subject_id: 'nora',
      id: 'k2',
      revoked_at: '2026-11-15T10:05:00.000Z',
    });

    const revokedCount = await store.revokeAllForOwner({
      tenant_id: 'default',
      subject_id: 'nora',
      revoked_at: '2026-11-15T10:06:00.000Z',
    });
    expect(revokedCount).toBe(1);
    const noraKeys = await store.listForOwner({ tenant_id: 'default', subject_id: 'nora' });
    expect(noraKeys.every(record => record.revoked_at !== null)).toBe(true);
    const wendyKeys = await store.listForOwner({ tenant_id: 'default', subject_id: 'wendy' });
    expect(wendyKeys).toHaveLength(1);
    expect(wendyKeys[0]?.revoked_at).toBeNull();
    await db.destroy();
  });
});
