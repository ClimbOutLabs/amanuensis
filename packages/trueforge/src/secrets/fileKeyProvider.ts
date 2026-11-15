import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

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
 * has not run yet. Read in one go, because start-up needs the key before anything can wait.
 */
export function readKeyFile(path: string): KeyLoadResult {
  let text: string;
  try {
    const file = openSync(path, 'r');
    try {
      // Checked on the open file, so the file that is read is the one that was checked.
      if ((fstatSync(file).mode & 0o077) !== 0) {
        return {
          status: 'unavailable',
          reason: 'Other accounts on this computer can read the key file. Run Aman setup again to fix it.',
        };
      }
      text = readFileSync(file, 'utf8');
    } finally {
      closeSync(file);
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

export class FileKeyProvider implements KeyProvider {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Promise<KeyLoadResult> {
    try {
      return Promise.resolve(readKeyFile(this.#path));
    } catch (caught) {
      return Promise.reject(caught instanceof Error ? caught : new Error('Could not read the key file'));
    }
  }
}
