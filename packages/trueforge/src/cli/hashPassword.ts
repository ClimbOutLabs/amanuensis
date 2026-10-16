import bcrypt from 'bcryptjs';

import type { Command } from './command';
import { UsageError } from './io';

const BCRYPT_ROUNDS = 10;
/** bcrypt ignores everything past 72 bytes, so a longer password would be silently truncated. */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

function stripTrailingNewline(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

/** Reads a password on stdin and prints `{"hash": "<bcrypt>"}`; the password never touches argv or env. */
export const hashPassword: Command = async ({ args, io }) => {
  if (args.length > 0) {
    throw new UsageError('hash-password takes no arguments; send the password on stdin.');
  }
  const password = stripTrailingNewline(await io.readStdin());
  if (password.length === 0) {
    throw new UsageError('The password on stdin is empty.');
  }
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    throw new UsageError(
      `The password is longer than ${String(BCRYPT_MAX_PASSWORD_BYTES)} bytes, which bcrypt cannot hash.`,
    );
  }
  // Dex documents the $2a$ prefix; the hash is identical to $2b$ for passwords under 72 bytes.
  const hash = (await bcrypt.hash(password, BCRYPT_ROUNDS)).replace(/^\$2b\$/, '$2a$');
  await io.stdout(`${JSON.stringify({ hash })}\n`);
  return 0;
};
