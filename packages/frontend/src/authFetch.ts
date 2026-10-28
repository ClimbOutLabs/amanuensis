/**
 * Browser auth entry points. Login and logout are not SDK methods (cookie session).
 * On any HTTP 401, redirect to OIDC login (session required), asking to come back to the page
 * the user was on: the sign-in expires mid-conversation, and landing on the home page afterwards
 * reads as the chat having vanished.
 *
 * Auth URLs share the public prefix with the UI (e.g. `/custom/proxy/path/api/v1/auth/...`).
 * A reverse proxy strips that prefix before Harness.
 */
import { apiPath, UI_BASE_PATH } from './publicPath';

/**
 * How long a 401 response is held back while the sign-in redirect takes the page away. If the page
 * is still here after this, the redirect is not coming (the page was restored from the browser's
 * back-forward cache, or sign-in bounced back to an app that still cannot read), so the caller gets
 * the real response instead of a load that hangs forever.
 */
const AUTH_REDIRECT_SETTLE_MS = 5_000;

/** Browser entry for login (not available as an SDK method). */
export const AUTH_LOGIN_HREF = apiPath('/api/v1/auth/login');

/** Clears the local session cookie (not available as an SDK method). */
export const AUTH_LOGOUT_HREF = apiPath('/api/v1/auth/logout');

/** Login URL with a same-origin post-login `return_to` (defaults to the UI home). */
export function buildLoginHref(returnTo: string = UI_BASE_PATH): string {
  const params = new URLSearchParams({ return_to: returnTo });
  return `${AUTH_LOGIN_HREF}?${params.toString()}`;
}

/** The login entry with the current page as the return path; the server keeps only same-origin paths. */
export function loginHrefReturningTo(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return returnTo === '/' ? AUTH_LOGIN_HREF : `${AUTH_LOGIN_HREF}?return_to=${encodeURIComponent(returnTo)}`;
}

export function createAuthAwareFetch(baseFetch: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  let redirecting = false;

  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (response.status !== 401 || typeof window === 'undefined') {
      return response;
    }

    if (!redirecting) {
      redirecting = true;
      window.location.assign(loginHrefReturningTo(window.location));
    }

    // Do not surface 401 to callers — boot would flash a config error before navigation.
    // The hold is bounded: if the redirect has not taken the page away within a few seconds, hand
    // back the real response so the caller's load settles on an error instead of spinning forever.
    return new Promise<Response>(resolve => {
      setTimeout(() => {
        resolve(response);
      }, AUTH_REDIRECT_SETTLE_MS);
    });
  };
}
