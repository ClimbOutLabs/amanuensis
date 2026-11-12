import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { checkMasterKey } from './keyCheck';
import type { KeyProvider } from './keyProvider';
import { recoverMasterKey } from './recoveryKey';
import { decryptSecret, encryptSecret, type SecretContext } from './secretCipher';

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
    const match = await checkMasterKey({ settings: this.#settings, key: loaded.key });
    if (match !== 'match') {
      return this.#lock(
        match,
        match === 'not_set_up' ? 'This database has no key check value' : 'The key does not match this database',
      );
    }
    this.#key = loaded.key;
    this.#state = { status: 'unlocked' };
    return this.#state;
  }

  /**
   * Unlocks with the recovery key when the host has no usable key (cleared TPM, new machine).
   * Returns the master key so the caller can protect it again on this machine.
   */
  async unlockWithRecoveryKey(recoveryKey: string): Promise<Buffer> {
    const key = await recoverMasterKey({ settings: this.#settings, recoveryKey });
    this.#key = key;
    this.#state = { status: 'unlocked' };
    return key;
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
