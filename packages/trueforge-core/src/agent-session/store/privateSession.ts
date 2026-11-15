import type { CreateSessionInput } from './ISessionStore';
import { SessionStoreInvariantError } from './SessionStoreErrors';

/**
 * A private chat always has a deletion time and any other chat never has one. Every store checks
 * this before writing, so a private chat can never be stored without a way to be swept.
 */
export function assertPrivateExpiryMatches(
  input: Pick<CreateSessionInput, 'session_id' | 'is_incognito' | 'private_expires_at'>,
): void {
  if (input.is_incognito && input.private_expires_at === null) {
    throw new SessionStoreInvariantError(`Private session ${input.session_id} needs a private_expires_at`);
  }
  if (!input.is_incognito && input.private_expires_at !== null) {
    throw new SessionStoreInvariantError(`Session ${input.session_id} is not private; private_expires_at must be null`);
  }
}
