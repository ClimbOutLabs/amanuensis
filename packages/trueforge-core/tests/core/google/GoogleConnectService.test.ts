import {
  GoogleClientError,
  GoogleConnectService,
  GoogleConsentError,
} from '../../../src/core/google/GoogleConnectService';
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from '../../../src/core/google/oauth';
import type { GoogleSetupInfo } from '../../../src/core/google/setupMode';
import { connectedRecord, FakeConnections, FakeGoogle, FakePending, json, OWNER } from './fakes';

const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
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
  const service = new GoogleConnectService({ connections, pending, now: () => clock, fetchImpl: google.fetch });
  return {
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

    it('rejects a state that is not the one in flight, and the attempt is spent', async () => {
      const { service, google } = setup();
      google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', refresh_token: 'rt', scope: READ }));
      const { authorization_url } = await service.begin({
        owner: OWNER,
        setup: SETUP,
        client: CLIENT,
        features: ['gmail_read'],
      });
      await expect(service.complete({ owner: OWNER, state: 'forged', code: 'code' })).rejects.toBeInstanceOf(
        GoogleConsentError,
      );
      await expect(service.complete({ owner: OWNER, state: stateOf(authorization_url), code: 'code' })).rejects.toThrow(
        /no connection in progress/,
      );
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
      expect(await service.test(OWNER)).toEqual({ ok: true, account_email: 'ada@example.com' });
    });

    it('flips the login to needs-reconnect when Google says invalid_grant', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord());
      google.on(GOOGLE_TOKEN_URL, () => json({ error: 'invalid_grant' }, 400));
      expect(await service.test(OWNER)).toEqual({ ok: false, reason: 'needs_reconnect' });
      expect((await connections.get(OWNER))?.status).toBe('needs_reconnect');
    });

    it('reports a missing login and an unreachable Google separately', async () => {
      const { service, google, connections } = setup();
      expect(await service.test(OWNER)).toEqual({ ok: false, reason: 'not_connected' });
      await connections.save(connectedRecord());
      google.on(GOOGLE_TOKEN_URL, () => new Response('', { status: 503 }));
      expect(await service.test(OWNER)).toEqual({ ok: false, reason: 'unreachable' });
      expect((await connections.get(OWNER))?.status).toBe('connected');
    });
  });

  describe('disconnect', () => {
    it('revokes at Google, then deletes the login', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ refresh_token: 'rt-live' }));
      google.on(GOOGLE_REVOKE_URL, () => new Response('', { status: 200 }));
      expect(await service.disconnect(OWNER)).toBe('disconnected');
      expect(google.requests[0]?.body?.get('token')).toBe('rt-live');
      expect(await connections.get(OWNER)).toBeNull();
    });

    it('keeps the login when Google cannot confirm the revocation', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord());
      google.on(GOOGLE_REVOKE_URL, () => new Response('', { status: 503 }));
      expect(await service.disconnect(OWNER)).toBe('revoke_failed');
      expect(await connections.get(OWNER)).not.toBeNull();
    });

    it('clears a login Google already rejects', async () => {
      const { service, google, connections } = setup();
      await connections.save(connectedRecord({ status: 'needs_reconnect' }));
      google.on(GOOGLE_REVOKE_URL, () => json({ error: 'invalid_token' }, 400));
      expect(await service.disconnect(OWNER)).toBe('disconnected');
      expect(await connections.get(OWNER)).toBeNull();
    });
  });
});
