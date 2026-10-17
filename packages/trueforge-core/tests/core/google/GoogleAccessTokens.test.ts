import { GoogleOAuthError, GoogleReconnectRequiredError } from '../../../src/core/google/errors';
import { GoogleAccessTokens } from '../../../src/core/google/GoogleAccessTokens';
import { GOOGLE_TOKEN_URL } from '../../../src/core/google/oauth';
import { connectedRecord, FakeConnections, FakeGoogle, json, OWNER } from './fakes';

describe('GoogleAccessTokens', () => {
  it('refreshes once and reuses the token until it is about to lapse', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord());
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at', expires_in: 3600 }));
    let now = 0;
    const tokens = new GoogleAccessTokens({ connections, owner: OWNER, now: () => now, fetchImpl: google.fetch });

    expect((await tokens.get()).access_token).toBe('at');
    await tokens.get();
    expect(google.requests).toHaveLength(1);

    now = 3600 * 1000;
    await tokens.get();
    expect(google.requests).toHaveLength(2);
  });

  it('hands back the scopes that were granted, so tools can be gated on them', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord({ granted_scopes: ['s1', 's2'] }));
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
    const access = await new GoogleAccessTokens({
      now: undefined,
      connections,
      owner: OWNER,
      fetchImpl: google.fetch,
    }).get();
    expect(access.granted_scopes).toEqual(['s1', 's2']);
  });

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'flips the login to needs-reconnect on %s and stops asking Google',
    async code => {
      const connections = new FakeConnections();
      await connections.save(connectedRecord());
      const google = new FakeGoogle();
      google.on(GOOGLE_TOKEN_URL, () => json({ error: code }, 400));
      const tokens = new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl: google.fetch });

      await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
      expect((await connections.get(OWNER))?.status).toBe('needs_reconnect');
      await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
      expect(google.requests).toHaveLength(1);
    },
  );

  it('keeps the login connected when Google cannot be reached, and says so plainly', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord());
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND oauth2.googleapis.com'));
    const tokens = new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl });
    const error = await tokens.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(String(error)).not.toContain('ENOTFOUND');
    expect(String(error)).toContain('Could not reach Google');
    expect((await connections.get(OWNER))?.status).toBe('connected');
  });

  it('gives the token request a time limit', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord());
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      signal = init?.signal;
      return Promise.resolve(json({ access_token: 'at' }));
    };
    await new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl }).get();
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('needs a login', async () => {
    const tokens = new GoogleAccessTokens({
      now: undefined,
      fetchImpl: undefined,
      connections: new FakeConnections(),
      owner: OWNER,
    });
    await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
  });
});
