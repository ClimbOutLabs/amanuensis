import { randomBytes } from 'node:crypto';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { KeyProvider } from './keyProvider';
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

/**
 * Why secrets are locked. `no_key`: the host has not delivered a key yet. `not_set_up`: this
 * database has no key check value, so setup has not run. `wrong_key`: the key does not match.
 */
export type SecretVaultState =
  { status: 'unlocked' } | { status: 'locked'; reason: 'no_key' | 'not_set_up' | 'wrong_key'; detail: string };

export class SecretsLockedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Saved secrets are locked. Enter your recovery key or finish setup to unlock them.', options);
    this.name = 'SecretsLockedError';
  }
}

export class SecretsAlreadySetUpError extends Error {
  constructor() {
    super('Secrets are already set up for this database. Use your recovery key instead of making a new key.');
    this.name = 'SecretsAlreadySetUpError';
  }
}

/**
 * Holds the master key in memory once it matches this database's key check value. While locked,
 * every encrypt and decrypt throws, so nothing is ever read or written in plain text.
 */
export class SecretVault {
  readonly #provider: KeyProvider;
  readonly #settings: IGlobalSettingsStore;
  #key: Buffer | undefined;
  #state: SecretVaultState = { status: 'locked', reason: 'no_key', detail: 'Not checked yet' };

  constructor({ provider, settings }: { provider: KeyProvider; settings: IGlobalSettingsStore }) {
    this.#provider = provider;
    this.#settings = settings;
  }

  get state(): SecretVaultState {
    return this.#state;
  }

  /** Loads the key and checks it against this database. Safe to call again while locked. */
  async refresh(): Promise<SecretVaultState> {
    if (this.#state.status === 'unlocked') {
      return this.#state;
    }
    const loaded = await this.#provider.load();
    if (loaded.status === 'unavailable') {
      return this.#lock('no_key', loaded.reason);
    }
    const check = await this.#settings.getSetting({ key: KEY_CHECK_SETTING });
    if (check === undefined) {
      return this.#lock('not_set_up', 'This database has no key check value');
    }
    try {
      const plaintext = decryptSecret({ key: loaded.key, value: check.value, context: KEY_CHECK_CONTEXT });
      if (plaintext !== KEY_CHECK_PLAINTEXT) {
        return this.#lock('wrong_key', 'The key check value does not match');
      }
    } catch (caught) {
      if (caught instanceof SecretKeyMismatchError || caught instanceof SecretDecryptError) {
        return this.#lock('wrong_key', 'The key does not match this database');
      }
      throw caught;
    }
    this.#key = loaded.key;
    this.#state = { status: 'unlocked' };
    return this.#state;
  }

  encrypt({ plaintext, context }: { plaintext: string; context: SecretContext }): string {
    return encryptSecret({ key: this.#unlockedKey(), plaintext, context });
  }

  decrypt({ value, context }: { value: string; context: SecretContext }): string {
    return decryptSecret({ key: this.#unlockedKey(), value, context });
  }

  #unlockedKey(): Buffer {
    if (this.#key === undefined) {
      throw new SecretsLockedError();
    }
    return this.#key;
  }

  #lock(reason: 'no_key' | 'not_set_up' | 'wrong_key', detail: string): SecretVaultState {
    this.#key = undefined;
    this.#state = { status: 'locked', reason, detail };
    return this.#state;
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
