import type {
  GoogleConnectionStore,
  PendingGoogleAuthorizationStore,
} from '@truefoundry/trueforge-core/core/google/connection';

/** Pending consents older than this are dropped, so an abandoned attempt cannot keep a client secret around. */
export const PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS = 60 * 60 * 1000;

/**
 * Durable Google logins and the one consent each user can have in flight. A user with no row is not
 * connected. Core reads and writes through the two ports; the server adds nothing to them.
 */
export interface IGoogleConnectionStore extends GoogleConnectionStore, PendingGoogleAuthorizationStore {}

/** Space-separated scope lists are how Google reports them and how both databases store them. */
export function splitScopes(stored: string): string[] {
  return stored.split(' ').filter(scope => scope !== '');
}
