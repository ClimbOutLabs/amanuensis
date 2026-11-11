import type { LocalAccountApi } from '@truefoundry/trueforge-ui';

const CHANGE_PASSWORD_URL = '/api/v1/auth/change-password';
const COULD_NOT_REACH_LINE = "Couldn't reach the server. Check your connection and try again.";
const DID_NOT_WORK_LINE = 'Your password could not be changed. Try again in a moment.';

/** The server's own line for a refused change, read defensively; undefined when it sent none. */
function serverErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error: unknown = Reflect.get(body, 'error');
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const message: unknown = Reflect.get(error, 'message');
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * Backs `LocalAccountProvider`: the change-password route is not on the generated SDK
 * (it is marked to stay off it, like sign-in itself), so this is a plain fetch with the
 * browser session cookie through the app's auth-aware fetch.
 */
export function createLocalAccountApi(fetcher: typeof fetch): LocalAccountApi {
  return {
    async changePassword(input) {
      let response: Response;
      try {
        response = await fetcher(CHANGE_PASSWORD_URL, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      } catch (cause) {
        throw new Error(COULD_NOT_REACH_LINE, { cause });
      }
      if (response.ok) {
        return;
      }
      const body: unknown = await response.json().catch(() => undefined);
      throw new Error(serverErrorMessage(body) ?? DID_NOT_WORK_LINE);
    },
  };
}
