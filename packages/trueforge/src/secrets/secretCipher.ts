import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** AES-256 master key length in bytes. */
export const MASTER_KEY_BYTES = 32;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 8;
const PREFIX_V1 = 'enc:v1:';

/**
 * Where an encrypted value lives. It is bound into the ciphertext, so a value copied to another
 * row or field fails to decrypt. `primary_key` MUST be the row's declared primary key value
 * (for composite keys, a stable join of its parts), never SQLite's implicit rowid, which VACUUM
 * can renumber.
 */
export interface SecretContext {
  table: string;
  primary_key: string;
  field: string;
}

/** The value is not an encrypted secret, or it was changed, or it belongs to another row or field. */
export class SecretDecryptError extends Error {
  constructor(options?: ErrorOptions) {
    super('Could not decrypt a saved secret', options);
    this.name = 'SecretDecryptError';
  }
}

/** The value was encrypted with a different master key than the one loaded. */
export class SecretKeyMismatchError extends Error {
  constructor() {
    super('A saved secret was encrypted with a different key');
    this.name = 'SecretKeyMismatchError';
  }
}

/** Short public fingerprint of a master key, stored with each value so key changes can be detected and rotated. */
export function masterKeyId(key: Buffer): Buffer {
  assertMasterKey(key);
  return createHmac('sha256', key).update('aman secrets key id').digest().subarray(0, KEY_ID_BYTES);
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX_V1);
}

export function encryptSecret({
  key,
  plaintext,
  context,
}: {
  key: Buffer;
  plaintext: string;
  context: SecretContext;
}): string {
  assertMasterKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const body = Buffer.concat([masterKeyId(key), nonce, ciphertext, cipher.getAuthTag()]);
  return `${PREFIX_V1}${body.toString('base64url')}`;
}

export function decryptSecret({ key, value, context }: { key: Buffer; value: string; context: SecretContext }): string {
  assertMasterKey(key);
  if (!isEncryptedSecret(value)) {
    throw new SecretDecryptError();
  }
  const body = Buffer.from(value.slice(PREFIX_V1.length), 'base64url');
  if (body.length < KEY_ID_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw new SecretDecryptError();
  }
  const keyId = body.subarray(0, KEY_ID_BYTES);
  if (!keyId.equals(masterKeyId(key))) {
    throw new SecretKeyMismatchError();
  }
  const nonce = body.subarray(KEY_ID_BYTES, KEY_ID_BYTES + NONCE_BYTES);
  const ciphertext = body.subarray(KEY_ID_BYTES + NONCE_BYTES, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (caught) {
    throw new SecretDecryptError({ cause: caught });
  }
}

function associatedData(context: SecretContext): Buffer {
  // JSON of a fixed-order array is unambiguous: no two contexts encode to the same bytes.
  return Buffer.from(JSON.stringify(['aman-secret', 1, context.table, context.primary_key, context.field]), 'utf8');
}

function assertMasterKey(key: Buffer): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`The secrets key must be ${String(MASTER_KEY_BYTES)} bytes`);
  }
}
