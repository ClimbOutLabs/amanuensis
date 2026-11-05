import { open } from 'node:fs/promises';

import { errorCode } from '../cli/errorCode';
import type { KeyLoadResult, KeyProvider } from './keyProvider';
import { MASTER_KEY_BYTES } from './secretCipher';

/** The key file holds the master key as one line of base64. */
export function encodeKeyFile(key: Buffer): string {
  return `${key.toString('base64')}\n`;
}

export function decodeKeyFile(text: string): Buffer | undefined {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return undefined;
  }
  const key = Buffer.from(trimmed, 'base64');
  return key.length === MASTER_KEY_BYTES ? key : undefined;
}

/**
 * Reads the master key from the file the host fills (a memory-only file from the TPM or keychain
 * job, or the key file on a machine without a TPM). A missing file is normal while the host job
 * has not run yet.
 */
export class FileKeyProvider implements KeyProvider {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<KeyLoadResult> {
    let text: string;
    try {
      const file = await open(this.#path, 'r');
      try {
        // Checked on the open file, so the file that is read is the one that was checked.
        const { mode } = await file.stat();
        if ((mode & 0o077) !== 0) {
          return {
            status: 'unavailable',
            reason: 'Other accounts on this computer can read the key file. Run Aman setup again to fix it.',
          };
        }
        text = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (caught) {
      const code = errorCode(caught);
      if (code === 'ENOENT') {
        return { status: 'unavailable', reason: 'The key has not been delivered yet' };
      }
      if (code === 'EACCES') {
        return { status: 'unavailable', reason: 'Aman is not allowed to read the key file' };
      }
      throw new Error('Could not read the key file', { cause: caught });
    }
    const key = decodeKeyFile(text);
    return key === undefined
      ? { status: 'unavailable', reason: 'The key file is not a valid key' }
      : { status: 'loaded', key };
  }
}
