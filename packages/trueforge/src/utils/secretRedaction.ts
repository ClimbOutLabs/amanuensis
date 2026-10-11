/**
 * Redact secret strings for settings API responses and detect/merge
 * redacted writebacks so clients can keep stored secrets without resending them.
 */

/** Fixed response mask: carries no key material, not even the secret's length. */
export const SECRET_REDACTION = '***REDACTED***';

/**
 * True when the client sent a redacted stand-in from a prior GET.
 */
export function isRedactedSecretValue(value: string): boolean {
  return value.includes(SECRET_REDACTION);
}

/**
 * Thrown when a redacted keep is requested but no stored secret exists
 * (create with redacted stand-in, or keep for a missing field/header).
 * Callers map this to a domain-specific 400 message.
 */
export class MissingStoredSecretError extends Error {
  constructor() {
    super('Missing stored secret');
    this.name = 'MissingStoredSecretError';
  }
}

/**
 * Resolve the secret to persist for a strict PUT field (always a non-empty string).
 * Real secrets are stored as-is; redacted stand-ins keep `existing` when present.
 * @throws {MissingStoredSecretError} when keep is requested with no stored secret
 */
export function resolveStoredSecretValue({
  incoming,
  existing,
}: {
  incoming: string;
  existing: string | undefined;
}): string {
  if (!isRedactedSecretValue(incoming)) {
    return incoming;
  }
  if (existing) {
    return existing;
  }
  throw new MissingStoredSecretError();
}
