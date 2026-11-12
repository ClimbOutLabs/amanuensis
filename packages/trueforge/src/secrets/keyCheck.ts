import { randomBytes } from 'node:crypto';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import {
  MASTER_KEY_BYTES,
  SecretDecryptError,
  SecretKeyMismatchError,
  decryptSecret,
  encryptSecret,
  type SecretContext,
} from './secretCipher';

/** Global setting that holds the key check value for this instance's database. */
export const KEY_CHECK_SETTING = 'secrets_key_check';

const KEY_CHECK_PLAINTEXT = 'aman secrets key check';
const KEY_CHECK_CONTEXT: SecretContext = {
  table: 'global_settings',
  primary_key: KEY_CHECK_SETTING,
  field: 'value',
};

export class SecretsAlreadySetUpError extends Error {
  constructor() {
    super('Secrets are already set up for this database. Use your recovery key instead of making a new key.');
    this.name = 'SecretsAlreadySetUpError';
  }
}

/** Whether `key` is the master key this database was set up with. */
export async function checkMasterKey({
  settings,
  key,
}: {
  settings: IGlobalSettingsStore;
  key: Buffer;
}): Promise<'match' | 'not_set_up' | 'wrong_key'> {
  const check = await settings.getSetting({ key: KEY_CHECK_SETTING });
  if (check === undefined) {
    return 'not_set_up';
  }
  try {
    return decryptSecret({ key, value: check.value, context: KEY_CHECK_CONTEXT }) === KEY_CHECK_PLAINTEXT
      ? 'match'
      : 'wrong_key';
  } catch (caught) {
    if (caught instanceof SecretKeyMismatchError || caught instanceof SecretDecryptError) {
      return 'wrong_key';
    }
    throw caught;
  }
}

/** A new random master key. Only setup calls this, and it saves the key before recording its check value. */
export function createMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

/**
 * Records the key check value for a key that setup has already saved on the host. It only writes
 * when this database has none, so an existing setup is never replaced by a new key.
 */
export async function recordKeyCheck({
  settings,
  key,
}: {
  settings: IGlobalSettingsStore;
  key: Buffer;
}): Promise<void> {
  const value = encryptSecret({ key, plaintext: KEY_CHECK_PLAINTEXT, context: KEY_CHECK_CONTEXT });
  const wrote = await settings.compareAndSetSetting({ key: KEY_CHECK_SETTING, expected: null, value });
  if (!wrote) {
    throw new SecretsAlreadySetUpError();
  }
}
