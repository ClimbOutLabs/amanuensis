import bcrypt from 'bcryptjs';

/** The bcrypt cost every password hash in Aman uses; the installer's hash helper shares it. */
export const PASSWORD_BCRYPT_ROUNDS = 10;
/** bcrypt ignores everything past 72 bytes, so a longer password would be silently cut short. */
export const PASSWORD_MAX_BYTES = 72;

/** The one message for a password bcrypt cannot take whole. */
export function passwordTooLongMessage(): string {
  return `The password is longer than ${String(PASSWORD_MAX_BYTES)} bytes, which the password check cannot handle. Use a shorter one.`;
}

/** Hash a password for storage. The `$2a$` prefix is the one the sign-in service documents; the hash is the same either way. */
export async function hashPasswordValue(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS);
  return hash.replace(/^\$2b\$/, '$2a$');
}

/** Check a typed password against a stored hash; the comparison runs in bcrypt's own constant time. */
export async function verifyPasswordValue(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
