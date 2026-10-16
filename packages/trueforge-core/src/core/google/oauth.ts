/**
 * Google OAuth for the user's own client: authorization code flow with PKCE (S256) and a 256-bit state.
 * Only the standard client flow lives here; nothing about tokens or login is invented.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GoogleOAuthError } from './errors';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export interface OAuthClient {
  client_id: string;
  client_secret: string;
}

/** 64 random bytes give an 86 character verifier, inside the 43 to 128 the PKCE spec allows. */
export function generatePkceVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/**
 * The consent address for the user's own client. A later consent names the earlier scopes too, so adding a
 * feature never narrows the login.
 */
export function buildAuthorizationUrl(input: {
  client_id: string;
  redirect_uri: string;
  scopes: readonly string[];
  state: string;
  pkce_verifier: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: pkceChallenge(input.pkce_verifier),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

const OAuthErrorBodySchema = z.object({ error: z.string(), error_description: z.string().optional() });

type FetchImpl = typeof fetch;

/** Longest a request to Google may take. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 15_000;

/** A request to Google that fails to connect, or runs out of time, becomes a plain, retryable error. */
export async function fetchGoogle(input: { fetchImpl: FetchImpl; url: string; init: RequestInit }): Promise<Response> {
  try {
    return await input.fetchImpl(input.url, { ...input.init, signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new GoogleOAuthError({
      message: 'Could not reach Google. Check your connection and try again in a minute.',
      code: null,
      status: 0,
      cause: error,
    });
  }
}

async function postForm(input: {
  url: string;
  params: Record<string, string>;
  fetchImpl: FetchImpl;
}): Promise<Response> {
  return await fetchGoogle({
    fetchImpl: input.fetchImpl,
    url: input.url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(input.params).toString(),
    },
  });
}

/** Turns a failed token response into an error that names Google's code and nothing else from the body. */
async function tokenError(response: Response): Promise<GoogleOAuthError> {
  const body = OAuthErrorBodySchema.safeParse(await response.json().catch(() => undefined));
  const code = body.success ? body.data.error : null;
  return new GoogleOAuthError({
    message: `Google refused the token request (HTTP ${String(response.status)}${code === null ? '' : `, ${code}`}).`,
    code,
    status: response.status,
  });
}

export interface TokenExchange {
  access_token: string;
  refresh_token: string;
  expires_in_seconds: number;
  scopes: string[];
}

/** Trades the authorization code and PKCE verifier for tokens. */
export async function exchangeCodeForTokens(input: {
  client: OAuthClient;
  code: string;
  pkce_verifier: string;
  redirect_uri: string;
  fetchImpl: FetchImpl | undefined;
}): Promise<TokenExchange> {
  const response = await postForm({
    url: GOOGLE_TOKEN_URL,
    fetchImpl: input.fetchImpl ?? fetch,
    params: {
      client_id: input.client.client_id,
      client_secret: input.client.client_secret,
      code: input.code,
      code_verifier: input.pkce_verifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirect_uri,
    },
  });
  if (!response.ok) {
    throw await tokenError(response);
  }
  const body = TokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success || body.data.refresh_token === undefined) {
    throw new GoogleOAuthError({
      message:
        'Google did not return a long-lived login. Remove Aman at myaccount.google.com/permissions and connect again.',
      code: null,
      status: response.status,
    });
  }
  return {
    access_token: body.data.access_token,
    refresh_token: body.data.refresh_token,
    expires_in_seconds: body.data.expires_in ?? 3600,
    scopes: (body.data.scope ?? '').split(' ').filter(scope => scope !== ''),
  };
}

/** A fresh access token from the stored refresh token. `invalid_grant` means the login must be redone. */
export async function refreshAccessToken(input: {
  client: OAuthClient;
  refresh_token: string;
  fetchImpl: FetchImpl | undefined;
}): Promise<{ access_token: string; expires_in_seconds: number }> {
  const response = await postForm({
    url: GOOGLE_TOKEN_URL,
    fetchImpl: input.fetchImpl ?? fetch,
    params: {
      client_id: input.client.client_id,
      client_secret: input.client.client_secret,
      refresh_token: input.refresh_token,
      grant_type: 'refresh_token',
    },
  });
  if (!response.ok) {
    throw await tokenError(response);
  }
  const body = TokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success) {
    throw new GoogleOAuthError({
      message: 'Google returned an unreadable token response.',
      code: null,
      status: response.status,
    });
  }
  return { access_token: body.data.access_token, expires_in_seconds: body.data.expires_in ?? 3600 };
}

/**
 * Revokes the login at Google. A token Google already rejects counts as revoked, so Disconnect still
 * clears a login that expired. Any other failure throws and the caller keeps the stored login.
 */
export async function revokeToken(input: { token: string; fetchImpl: FetchImpl | undefined }): Promise<void> {
  const response = await postForm({
    url: GOOGLE_REVOKE_URL,
    fetchImpl: input.fetchImpl ?? fetch,
    params: { token: input.token },
  });
  if (response.ok) {
    return;
  }
  const error = await tokenError(response);
  if (error.status === 400 && error.code === 'invalid_token') {
    return;
  }
  throw error;
}

const ProfileSchema = z.object({ emailAddress: z.string() });

/** The signed-in Gmail address, read with a live access token. */
export async function fetchProfileEmail(input: {
  access_token: string;
  fetchImpl: FetchImpl | undefined;
}): Promise<string> {
  const response = await fetchGoogle({
    fetchImpl: input.fetchImpl ?? fetch,
    url: GMAIL_PROFILE_URL,
    init: { headers: { Authorization: `Bearer ${input.access_token}` } },
  });
  if (!response.ok) {
    throw new GoogleOAuthError({
      message: `Google would not name the account (HTTP ${String(response.status)}).`,
      code: null,
      status: response.status,
    });
  }
  const profile = ProfileSchema.safeParse(await response.json().catch(() => undefined));
  if (!profile.success) {
    throw new GoogleOAuthError({
      message: 'Google returned an unreadable profile.',
      code: null,
      status: response.status,
    });
  }
  return profile.data.emailAddress;
}
