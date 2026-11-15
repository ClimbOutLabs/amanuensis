import { hkdfSync } from 'node:crypto';

import { MASTER_KEY_BYTES } from './secretCipher';

/**
 * The key that encrypts an instance's SQLite database file, derived from the master key so the
 * two are never the same bytes and nothing new has to be stored.
 */
export function deriveDatabaseKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'aman database v1', 'sqlite file', MASTER_KEY_BYTES));
}

/** The key that encrypts the knowledge library files, which sit beside the database and never share its key. */
export function deriveKnowledgeKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'aman database v1', 'knowledge file', MASTER_KEY_BYTES));
}
