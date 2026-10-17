import { randomBytes } from 'node:crypto';

/** An OAuth `state`: 32 random bytes, 256 bits, base64url. One generator for every OAuth flow the host starts. */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}
