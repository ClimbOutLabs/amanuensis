import { GoogleReconnectRequiredError } from '../../../src/core/google/errors';
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
    const access = await new GoogleAccessTokens({ connections, owner: OWNER, fetchImpl: google.fetch }).get();
    expect(access.granted_scopes).toEqual(['s1', 's2']);
  });

  it('flips the login to needs-reconnect on invalid_grant and stops asking Google', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord());
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () => json({ error: 'invalid_grant' }, 400));
    const tokens = new GoogleAccessTokens({ connections, owner: OWNER, fetchImpl: google.fetch });

    await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
    expect((await connections.get(OWNER))?.status).toBe('needs_reconnect');
    await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
    expect(google.requests).toHaveLength(1);
  });

  it('needs a login', async () => {
    const tokens = new GoogleAccessTokens({ connections: new FakeConnections(), owner: OWNER });
    await expect(tokens.get()).rejects.toBeInstanceOf(GoogleReconnectRequiredError);
  });
});
