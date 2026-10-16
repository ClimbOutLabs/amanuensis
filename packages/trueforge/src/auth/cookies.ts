import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Logger } from 'winston';
import { z } from 'zod';
import { getAllowedOrigins, getAuthCookieSuffix, getPublicBaseUrl } from '../config';
import { requestAllowedOrigin } from './allowedOrigins';

export const OAUTH_STATE_COOKIE = 'oauth_state';
export const ID_TOKEN_COOKIE = 'id_token';
export const ACCESS_TOKEN_COOKIE = 'accessToken';

const OAuthStateSchema = z.object({
  state: z.string(),
  code_verifier: z.string(),
  return_to: z.string(),
});

export type OAuthState = z.infer<typeof OAuthStateSchema>;

/** Browsers scope cookies by host, not port, so each instance suffixes every auth cookie name. */
function authCookieName(base: string): string {
  return `${base}${getAuthCookieSuffix()}`;
}

/**
 * Whether cookies need the Secure flag. Over plain http (an address on this computer or a private network) a Secure
 * cookie would never be sent back, so the flag follows the scheme of the listed origin the request came to; with no
 * list it follows the public address.
 */
function cookiesAreSecure(context: Context): boolean {
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length === 0) {
    return getPublicBaseUrl().startsWith('https://');
  }
  const origin = requestAllowedOrigin({ context, allowedOrigins });
  // An address that is not listed is refused before a cookie is set; if one gets here, the stricter choice is safe.
  return origin === undefined || origin.startsWith('https://');
}

function getAuthCookieAttributes(context: Context): {
  httpOnly: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: cookiesAreSecure(context),
    path: '/',
  };
}

export function setAuthCookie(params: { context: Context; name: string; value: string; maxAgeSeconds: number }): void {
  setCookie(params.context, authCookieName(params.name), params.value, {
    ...getAuthCookieAttributes(params.context),
    maxAge: params.maxAgeSeconds,
  });
}

export function readOAuthStateCookie(params: { context: Context; logger: Logger }): OAuthState | undefined {
  const raw = getCookie(params.context, authCookieName(OAUTH_STATE_COOKIE));
  if (!raw) {
    return undefined;
  }
  try {
    // JSON.parse throws SyntaxError when the cookie value is not JSON.
    const result = OAuthStateSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      params.logger.warn('oauth_state cookie failed schema validation', { error: result.error.message });
      return undefined;
    }
    return result.data;
  } catch (error) {
    params.logger.warn('oauth_state cookie is not valid JSON', {
      error: error instanceof Error ? error.message : error,
    });
    return undefined;
  }
}

export function clearAuthCookie(params: { context: Context; name: string }): void {
  deleteCookie(params.context, authCookieName(params.name), getAuthCookieAttributes(params.context));
}

export function readIdTokenCookie(params: { context: Context }): string | undefined {
  return getCookie(params.context, authCookieName(ID_TOKEN_COOKIE));
}

export function readAccessTokenCookie(params: { context: Context }): string | undefined {
  return getCookie(params.context, authCookieName(ACCESS_TOKEN_COOKIE));
}
