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

/** A connector that keeps its own account file, outside the database. */
export type AccountConnector = 'mail' | 'calendar';

/**
 * The key of one connector's account file. The connector is handed only this key, so it never
 * holds the master key and cannot open the database or the other connector's file.
 */
export function deriveConnectorKey({
  masterKey,
  connector,
}: {
  masterKey: Buffer;
  connector: AccountConnector;
}): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, 'aman connector v1', `${connector} account file`, MASTER_KEY_BYTES));
}
