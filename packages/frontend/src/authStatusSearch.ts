import type { SessionState } from './authSession';

/** Every reason the sign-in page can show, with its wording. A link can pick one of these and nothing else. */
const AUTH_ERROR_MESSAGES = {
  login_failed: 'We couldn’t complete sign-in. Please try again.',
  owner_only: 'Only the owner can sign in to this instance.',
};
export type AuthErrorReason = keyof typeof AUTH_ERROR_MESSAGES;

function isAuthErrorReason(value: string): value is AuthErrorReason {
  return Object.hasOwn(AUTH_ERROR_MESSAGES, value);
}

/** Reads `/?error=<code>` from a failed sign-in. Any value that is not a known code reads as `login_failed`. Returns null when not an error landing. */
export function parseAuthErrorReason(search: string): AuthErrorReason | null {
  const reason = new URLSearchParams(search).get('error')?.trim();
  if (!reason) {
    return null;
  }
  return isAuthErrorReason(reason) ? reason : 'login_failed';
}

export function authErrorMessage(reason: AuthErrorReason): string {
  return AUTH_ERROR_MESSAGES[reason];
}

/** Returns the error reason when the auth error screen should show; otherwise null. */
export function shouldShowAuthErrorScreen({
  authError,
  session,
}: {
  authError: AuthErrorReason | null;
  session: SessionState | { status: 'checking' };
}): AuthErrorReason | null {
  if (authError == null || session.status !== 'unauthenticated') {
    return null;
  }
  return authError;
}

/** Path + search + hash with the OIDC `error` query removed. */
export function stripAuthErrorSearch({
  pathname,
  search,
  hash,
}: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const params = new URLSearchParams(search);
  params.delete('error');
  const nextSearch = params.toString();
  return `${pathname}${nextSearch === '' ? '' : `?${nextSearch}`}${hash}`;
}
