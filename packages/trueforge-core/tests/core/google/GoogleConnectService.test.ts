import { createHash } from 'node:crypto';
import {
  GoogleClientError,
  GoogleConnectService,
  GoogleConsentError,
  GoogleFeatureError,
} from '../../../src/core/google/GoogleConnectService';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, hashState } from '../../../src/core/google/oauth';
import { grantedFeatures } from '../../../src/core/google/scopes';
import type { GoogleSetupInfo } from '../../../src/core/google/setupMode';
import { capturingLogger, connectedRecord, FakeConnections, FakeGoogle, FakePending, json, OWNER } from './fakes';

const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const SETUP: GoogleSetupInfo = {
  mode: 'paste',
  client_type: 'desktop',
  redirect_uri: 'http://127.0.0.1:53682/callback',
};
const CLIENT = {
  client_id: '123456789-abcdefghij.apps.googleusercontent.com',
  client_secret: 'GOCSPX-abcdefghijklmnop',
  client_type: 'desktop' as const,
};

function stateOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get('state') ?? '';
}

function setup(now = new Date('2026-10-15T12:00:00.000Z')) {
  const connections = new FakeConnections();
  const pending = new FakePending();
  const google = new FakeGoogle();
  let clock = now;
  const { logger, lines: warnings } = capturingLogger();
  const service = new GoogleConnectService({
    connections,
    pending,
    now: () => clock,
    fetchImpl: google.fetch,
    logger,
  });
  return {
    warnings,
    connections,
    pending,
    google,
    service,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('GoogleConnectService', () => {
  describe('begin and complete', () => {
    it('connects a user and stores exactly the scopes Google returned', async () => {
      const { service, google, connections } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));

      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      expect(new URL(authorization_url).searchParams.get('scope')).toBe(READ);

      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(record).toMatchObject({
        refresh_token: 'rt',
        granted_scopes: [READ],
        account_email: 'ada@example.com',
        status: 'connected',
      });
      expect(await connections.get(OWNER)).toEqual(record);
    });

    it('keeps each user separate', async () => {
      const { service, google, connections } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(await connections.get({ ...OWNER, created_by: 'someone-else' })).toBeNull();
    });

    it('rejects a state that is not the one in flight without spending the real attempt', async () => {
      const { service, google, pending } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      await expect(service.complete({ owner: OWNER, state: 'forged', code: 'code' })).rejects.toThrow(
        /does not belong to the connection in progress/,
      );
      expect(pending.records.size).toBe(1);
      expect(google.requests.some(request => request.url.startsWith(GOOGLE_TOKEN_URL))).toBe(false);
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(record.status).toBe('connected');
    });

    it('rejects a state that another user started', async () => {
      const { service } = setup();
      const other = { ...OWNER, created_by: 'someone-else' };
      const { authorization_url } = await service.begin({
        owner: other,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      await expect(service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' })).rejects.toThrow(
        /no connection in progress/,
      );
    });

    it('says there is nothing in progress when nothing was started, and spends an attempt only once', async () => {
      const { service, google } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      await expect(service.complete({ owner: OWNER, state: 'x', code: 'code' })).rejects.toThrow(
        /no connection in progress/,
      );
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      await expect(service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' })).rejects.toThrow(
        /no connection in progress/,
      );
    });

    it('proves the code with the verifier whose S256 challenge it sent, with a 256-bit state kept only as a hash', async () => {
      const { service, google, pending } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      const begun = new URL(authorization_url).searchParams;
      const state = begun.get('state') ?? '';
      expect(Buffer.from(state, 'base64url')).toHaveLength(32);
      expect(begun.get('code_challenge_method')).toBe('S256');
      const stored = [...pending.records.values()][0];
      expect(JSON.stringify(stored)).not.toContain(state);
      expect(stored?.state_hash).toBe(hashState(state));

      await service.complete({ owner: OWNER, state, code: 'the-code' });
      const exchange = google.requests.find(request => request.url.startsWith(GOOGLE_TOKEN_URL));
      const verifier = exchange?.body?.get('code_verifier') ?? '';
      expect(verifier).not.toBe('');
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(begun.get('code_challenge'));
      expect(exchange?.body?.get('code')).toBe('the-code');
    });

    it('explains a profile failure, and points at the API step when Google says 403', async () => {
      for (const [status, says] of [
        [403, /step 2/],
        [500, /could not reach Gmail/],
      ] as const) {
        const { service, google, connections } = setup();
        google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
        google.on(PROFILE_URL, () => json({ error: 'x' }, status));
        const { authorization_url } = await service.begin({
          owner: OWNER,
          setup: SETUP,
          client: CLIENT,
          features: ['gmail_read'],
        });
        await expect(
          service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' }),
        ).rejects.toThrow(says);
        expect(await connections.get(OWNER)).toBeNull();
      }
    });

    it('names the real cause when the profile call is refused because read permission was not granted', async () => {
      const { service, google, connections } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: COMPOSE }));
      google.on(PROFILE_URL, () => json({ error: 'insufficient' }, 403));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read', 'gmail_compose'],
      });
      const error = await service
        .complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' })
        .catch((caught: unknown) => caught);
      expect(error instanceof Error && error.message).toBe(
        "Aman wasn't given permission to read mail. Connect again and leave the read box ticked.",
      );
      expect(error instanceof Error && error.message).not.toContain('Gmail API');
      expect(await connections.get(OWNER)).toBeNull();
    });

    it('rejects a consent that took longer than ten minutes', async () => {
      const { service, advance } = setup();
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      advance(10 * 60 * 1000 + 1);
      await expect(service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' })).rejects.toThrow(
        /too long/,
      );
    });

    it('keeps the cause when Google refuses the code', async () => {
      const { service, google } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ error: 'invalid_grant' }, 400));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      const error = await service
        .complete({ owner: OWNER, state: stateOf(authorization_url), code: 'bad' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GoogleConsentError);
      expect(error instanceof Error && error.cause).toBeDefined();
    });

    it('refuses a client of the wrong type before any consent is stored', async () => {
      const { service, pending } = setup();
      await expect(
        service.begin({
          owner: OWNER,
          setup: SETUP,
          client: { ...CLIENT, client_type: 'web' },
          features: ['gmail_read'],
        }),
      ).rejects.toBeInstanceOf(GoogleClientError);
      expect(pending.records.size).toBe(0);
    });

    it('asks for a client when none was given and none is stored', async () => {
      const { service } = setup();
      await expect(
        service.begin({ owner: OWNER, setup: SETUP, client: null, features: ['gmail_read'] }),
      ).rejects.toBeInstanceOf(GoogleClientError);
    });
  });

  describe('adding a feature', () => {
    it('reuses the stored client, asks for the union, and never revokes the login it replaces', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ] }));
      google.on(GOOGLE_TOKEN_URL, () =>
        json({ access_token: 'at2', refresh_token: 'rt-new', scope: `${READ} ${COMPOSE}` }),
      );
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));

      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: null,
        features: ['gmail_compose'],
      });
      expect(new URL(authorization_url).searchParams.get('scope')).toBe(`${READ} ${COMPOSE}`);
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });

      expect(record.refresh_token).toBe('rt-new');
      expect(record.granted_scopes).toEqual([READ, COMPOSE]);
      expect(google.requests.some(request => request.url.startsWith(GOOGLE_REVOKE_URL))).toBe(false);
    });

    it('adds Calendar as a second consent: both scopes asked, both stored, the older token never revoked', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ, COMPOSE] }));
      google.on(GOOGLE_TOKEN_URL, () =>
        json({ access_token: 'at2', refresh_token: 'rt-new', scope: `${READ} ${COMPOSE} ${CALENDAR}` }),
      );
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));

      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: null,
        features: ['calendar_read'],
      });
      expect(new URL(authorization_url).searchParams.get('scope')).toBe(`${READ} ${COMPOSE} ${CALENDAR}`);
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });

      expect(record.refresh_token).toBe('rt-new');
      expect(record.granted_scopes).toEqual([READ, COMPOSE, CALENDAR]);
      expect(google.requests.some(request => request.url.startsWith(GOOGLE_REVOKE_URL))).toBe(false);
    });

    it('keeps Calendar through a later consent for something else', async () => {
      const { service, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ, CALENDAR] }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: null,
        features: ['gmail_compose'],
      });
      expect(new URL(authorization_url).searchParams.get('scope')).toBe(`${READ} ${COMPOSE} ${CALENDAR}`);
    });

    it('records no Calendar when the user unticked it on the consent screen', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ] }));
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: null,
        features: ['calendar_read'],
      });
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(grantedFeatures(record.granted_scopes)).toEqual(['gmail_read']);
    });

    it('lets a user who reads Calendar add events as one more consent, keeping every scope they had', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ, CALENDAR] }));
      google.on(GOOGLE_TOKEN_URL, () =>
        json({ access_token: 'at2', refresh_token: 'rt-new', scope: `${READ} ${CALENDAR} ${CALENDAR_WRITE}` }),
      );
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));

      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: null,
        features: ['calendar_read', 'calendar_write'],
      });
      expect(new URL(authorization_url).searchParams.get('scope')).toBe(`${READ} ${CALENDAR} ${CALENDAR_WRITE}`);
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(grantedFeatures(record.granted_scopes)).toEqual(['gmail_read', 'calendar_read', 'calendar_write']);
      expect(google.requests.some(request => request.url.startsWith(GOOGLE_REVOKE_URL))).toBe(false);
    });

    it('refuses to add events without Calendar, with a plain message', async () => {
      const { service, pending, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ] }));
      await expect(
        service.begin({ owner: OWNER, setup: SETUP, client: null, features: ['calendar_write'] }),
      ).rejects.toThrow('Adding events needs Calendar too');
      expect(pending.records.size).toBe(0);
    });

    it('refuses to ask for Calendar before mail is connected, with a plain message', async () => {
      const { service, pending } = setup();
      await expect(
        service.begin({ owner: OWNER, setup: SETUP, client: CLIENT, features: ['calendar_read'] }),
      ).rejects.toThrow('Connect Google first, then add Calendar');
      expect(pending.records.size).toBe(0);
    });

    it('refuses to ask for sending alone, with a plain message', async () => {
      const { service, pending } = setup();
      await expect(
        service.begin({ owner: OWNER, setup: SETUP, client: CLIENT, features: ['gmail_compose'] }),
      ).rejects.toThrow(GoogleFeatureError);
      await expect(
        service.begin({ owner: OWNER, setup: SETUP, client: CLIENT, features: ['gmail_compose'] }),
      ).rejects.toThrow('Sending needs permission to read mail too');
      expect(pending.records.size).toBe(0);
    });

    it('records fewer scopes when the user unticked one on the consent screen', async () => {
      const { service, google } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read', 'gmail_compose'],
      });
      const record = await service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' });
      expect(record.granted_scopes).toEqual([READ]);
    });
  });

  describe('test', () => {
    it('names the account', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord());
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      expect(await service.test(OWNER)).toEqual({ result: 'ok', account_email: 'ada@example.com' });
    });

    it('also checks Calendar when it was granted, and says when its API is off', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ, CALENDAR] }));
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      google.on(CALENDAR_EVENTS_URL, () =>
        json({ error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } }, 403),
      );
      expect(await service.test(OWNER)).toEqual({ result: 'calendar_unavailable', account_email: 'ada@example.com' });
    });

    it('passes when Calendar answers', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ granted_scopes: [READ, CALENDAR] }));
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
      google.on(PROFILE_URL, () => json({ emailAddress: 'ada@example.com' }));
      google.on(CALENDAR_EVENTS_URL, () => json({ timeZone: 'America/Sao_Paulo', items: [] }));
      expect(await service.test(OWNER)).toEqual({ result: 'ok', account_email: 'ada@example.com' });
    });

    it('flips the login to needs-reconnect when Google says invalid_grant', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord());
      google.on(GOOGLE_TOKEN_URL, () => json({ error: 'invalid_grant' }, 400));
      expect(await service.test(OWNER)).toEqual({ result: 'needs_reconnect', account_email: null });
      expect((await connections.get(OWNER))?.status).toBe('needs_reconnect');
    });

    it('reports a missing login and an unreachable Google separately', async () => {
      const { service, google, connections } = setup();
      expect(await service.test(OWNER)).toEqual({ result: 'not_connected', account_email: null });
      await connections.save(connectedRecord());
      google.on(GOOGLE_TOKEN_URL, () => new Response('', { status: 503 }));
      expect(await service.test(OWNER)).toEqual({ result: 'unreachable', account_email: null });
      expect((await connections.get(OWNER))?.status).toBe('connected');
    });

    it('logs why a test failed, without secrets', async () => {
      const { service, google, connections, warnings } = setup();
      await connections.save(connectedRecord({ refresh_token: 'rt-live-secret' }));
      google.on(GOOGLE_TOKEN_URL, () => json({ error: 'server_error' }, 503));
      await service.test(OWNER);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Google connection test failed');
      expect(warnings.join('')).not.toContain('rt-live-secret');
    });

    it('does not bring back a login that was disconnected while the test ran', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ account_email: 'old@example.com' }));
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
      google.on(PROFILE_URL, () => {
        connections.records.clear();
        return json({ emailAddress: 'ada@example.com' });
      });
      expect(await service.test(OWNER)).toEqual({ result: 'ok', account_email: 'ada@example.com' });
      expect(await connections.get(OWNER)).toBeNull();
    });

    it('does not overwrite a login that was reconnected while the test ran', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ account_email: 'old@example.com' }));
      const reconnected = connectedRecord({
        refresh_token: 'refresh-2',
        account_email: 'new@example.com',
        updated_at: '2026-10-16T00:00:00.000Z',
      });
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
      google.on(PROFILE_URL, () => {
        connections.records.set(`${OWNER.tenant_id}/${OWNER.created_by}`, reconnected);
        return json({ emailAddress: 'ada@example.com' });
      });
      await service.test(OWNER);
      expect(await connections.get(OWNER)).toEqual(reconnected);
    });

    it('does not flag a reconnected login as needing a reconnect', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord());
      const reconnected = connectedRecord({ refresh_token: 'refresh-2', updated_at: '2026-10-16T00:00:00.000Z' });
      google.on(GOOGLE_TOKEN_URL, () => {
        connections.records.set(`${OWNER.tenant_id}/${OWNER.created_by}`, reconnected);
        return json({ error: 'invalid_grant' }, 400);
      });
      expect(await service.test(OWNER)).toEqual({ result: 'needs_reconnect', account_email: null });
      expect(await connections.get(OWNER)).toEqual(reconnected);
    });
  });

  describe('disconnect', () => {
    it('revokes at Google, then deletes the login', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ refresh_token: 'rt-live' }));
      google.on(GOOGLE_REVOKE_URL, () => new Response('', { status: 200 }));
      expect(await service.disconnect(OWNER)).toBe('revoked');
      expect(google.requests[0]?.body?.get('token')).toBe('rt-live');
      expect(await connections.get(OWNER)).toBeNull();
    });

    it('still deletes the login when Google cannot confirm, says so, and logs without secrets', async () => {
      const { service, google, connections, warnings } = setup();
      await connections.save(connectedRecord({ refresh_token: 'rt-live-secret' }));
      google.on(GOOGLE_REVOKE_URL, () => new Response('', { status: 503 }));
      expect(await service.disconnect(OWNER)).toBe('removed_unconfirmed');
      expect(await connections.get(OWNER)).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Google did not confirm the revocation');
      expect(warnings.join('')).not.toContain('rt-live-secret');
      expect(warnings.join('')).not.toContain('secret-secret-secret');
    });

    it('still deletes the login when Google cannot be reached at all', async () => {
      const { connections } = setup();
      await connections.save(connectedRecord());
      const unreachable = new GoogleConnectService({
        connections,
        pending: new FakePending(),
        now: undefined,
        fetchImpl: () => Promise.reject(new Error('offline')),
        logger: capturingLogger().logger,
      });
      expect(await unreachable.disconnect(OWNER)).toBe('removed_unconfirmed');
      expect(await connections.get(OWNER)).toBeNull();
    });

    it('clears a login Google already rejects', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ status: 'needs_reconnect' }));
      google.on(GOOGLE_REVOKE_URL, () => json({ error: 'invalid_token' }, 400));
      expect(await service.disconnect(OWNER)).toBe('revoked');
      expect(await connections.get(OWNER)).toBeNull();
    });
  });
});
