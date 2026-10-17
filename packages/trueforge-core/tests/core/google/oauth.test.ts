import { GoogleOAuthError } from '../../../src/core/google/errors';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkceVerifier,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  hashState,
  pkceChallenge,
  refreshAccessToken,
  revokeToken,
} from '../../../src/core/google/oauth';
import { FakeGoogle, json } from './fakes';

const CLIENT = { client_id: 'id', client_secret: 'secret' };

describe('buildAuthorizationUrl', () => {
  it('carries PKCE S256, state and offline access, and does not ask Google to merge earlier grants', () => {
    const url = new URL(
      buildAuthorizationUrl({
        client_id: 'id',
        redirect_uri: 'http://127.0.0.1:53682/callback',
        scopes: ['a', 'b'],
        state: 'st',
        pkce_verifier: 'verifier',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge('verifier'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBeNull();
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes verifiers that are long, URL-safe and different each time', () => {
    const verifiers = new Set(Array.from({ length: 20 }, () => generatePkceVerifier()));
    expect(verifiers.size).toBe(20);
    for (const verifier of verifiers) {
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    }
  });
});

describe('token endpoints', () => {
  it('exchanges a code with the verifier and reads back the scopes Google granted', async () => {
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'x y' }),
    );
    const tokens = await exchangeCodeForTokens({
      client: CLIENT,
      code: 'code',
      pkce_verifier: 'ver',
      redirect_uri: 'http://127.0.0.1:53682/callback',
      fetchImpl: google.fetch,
    });
    expect(tokens).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in_seconds: 3599, scopes: ['x', 'y'] });
    expect(google.requests[0]?.body?.get('code_verifier')).toBe('ver');
    expect(google.requests[0]?.body?.get('grant_type')).toBe('authorization_code');
  });

  it('refuses an exchange that returns no refresh token', async () => {
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () => json({ access_token: 'at' }));
    await expect(
      exchangeCodeForTokens({
        client: CLIENT,
        code: 'c',
        pkce_verifier: 'v',
        redirect_uri: 'r',
        fetchImpl: google.fetch,
      }),
    ).rejects.toThrow(/long-lived login/);
  });

  it('names invalid_grant on a rejected refresh, without echoing the body', async () => {
    const google = new FakeGoogle();
    google.on(GOOGLE_TOKEN_URL, () =>
      json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    );
    const error = await refreshAccessToken({ client: CLIENT, refresh_token: 'rt', fetchImpl: google.fetch }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error instanceof GoogleOAuthError && error.needsReconnect).toBe(true);
    expect(String(error)).not.toContain('Token has been expired');
  });

  it('treats a token Google already rejects as revoked, and any other failure as a failure', async () => {
    const google = new FakeGoogle();
    google.on(GOOGLE_REVOKE_URL, () => json({ error: 'invalid_token' }, 400));
    await expect(revokeToken({ token: 't', fetchImpl: google.fetch })).resolves.toBeUndefined();
    google.on(GOOGLE_REVOKE_URL, () => new Response('', { status: 503 }));
    await expect(revokeToken({ token: 't', fetchImpl: google.fetch })).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

describe('hashState', () => {
  it('is stable and does not reveal the state', () => {
    expect(hashState('abc')).toBe(hashState('abc'));
    expect(hashState('abc')).not.toContain('abc');
  });
});
