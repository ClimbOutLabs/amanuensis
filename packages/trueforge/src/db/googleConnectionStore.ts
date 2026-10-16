import type {
  GoogleConnectionStore,
  PendingGoogleAuthorizationStore,
} from '@truefoundry/trueforge-core/core/google/connection';

/**
 * Pending consents older than this are dropped, so an abandoned attempt cannot keep a client secret around.
 * A little longer than the ten minutes a consent is good for, so "took too long" can still be said.
 */
export const PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS = 15 * 60 * 1000;

/**
 * Durable Google logins and the one consent each user can have in flight. A user with no row is not
 * connected. Core reads and writes through the two ports; the server adds nothing to them.
 */
export interface IGoogleConnectionStore extends GoogleConnectionStore, PendingGoogleAuthorizationStore {
  /** Drops consents past the retention window. Every consent read and write also does this, so the timer only covers idle installs. */
  purgeExpiredPending(): Promise<void>;
}

/** Space-separated scope lists are how Google reports them and how both databases store them. */
export function splitScopes(stored: string): string[] {
  return stored.split(' ').filter(scope => scope !== '');
}
