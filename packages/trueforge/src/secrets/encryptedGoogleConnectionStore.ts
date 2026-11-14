import type {
  GoogleConnectionRecord,
  GoogleConnectionVersion,
  GoogleOwner,
  PendingGoogleAuthorization,
} from '@truefoundry/trueforge-core/core/google/connection';

import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

type SecretTable = 'google_connection' | 'google_oauth_pending';

function context({ table, owner, field }: { table: SecretTable; owner: GoogleOwner; field: string }): SecretContext {
  return { table, primary_key: JSON.stringify([owner.tenant_id, owner.created_by]), field };
}

/**
 * Keeps the Google client secret and refresh token encrypted in the wrapped store, also while a
 * sign-in is still in progress. Callers pass and get the real values. A value saved before
 * encryption is read as it is until it is encrypted in place.
 */
export class EncryptedGoogleConnectionStore implements IGoogleConnectionStore {
  readonly #store: IGoogleConnectionStore;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: IGoogleConnectionStore; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  async get(owner: GoogleOwner): Promise<GoogleConnectionRecord | null> {
    const stored = await this.#store.get(owner);
    return stored === null ? null : this.#openConnection(stored);
  }

  async save(record: GoogleConnectionRecord): Promise<void> {
    await this.#store.save({
      ...record,
      client_secret: this.#seal(
        { table: 'google_connection', owner: record, field: 'client_secret' },
        record.client_secret,
      ),
      refresh_token: this.#seal(
        { table: 'google_connection', owner: record, field: 'refresh_token' },
        record.refresh_token,
      ),
    });
  }

  async markNeedsReconnect(input: { owner: GoogleOwner; expected: GoogleConnectionVersion }): Promise<boolean> {
    const expected = await this.#storedVersion(input);
    return expected === undefined ? false : await this.#store.markNeedsReconnect({ owner: input.owner, expected });
  }

  async setAccountEmail(input: {
    owner: GoogleOwner;
    expected: GoogleConnectionVersion;
    account_email: string;
    updated_at: string;
  }): Promise<boolean> {
    const expected = await this.#storedVersion(input);
    return expected === undefined ? false : await this.#store.setAccountEmail({ ...input, expected });
  }

  delete(owner: GoogleOwner): Promise<void> {
    return this.#store.delete(owner);
  }

  listConnectedOwners(): Promise<GoogleOwner[]> {
    return this.#store.listConnectedOwners();
  }

  async savePending(pending: PendingGoogleAuthorization): Promise<void> {
    await this.#store.savePending({
      ...pending,
      pkce_verifier: this.#seal(
        { table: 'google_oauth_pending', owner: pending, field: 'pkce_verifier' },
        pending.pkce_verifier,
      ),
      client_secret: this.#seal(
        { table: 'google_oauth_pending', owner: pending, field: 'client_secret' },
        pending.client_secret,
      ),
    });
  }

  async takePending(input: GoogleOwner & { state_hash: string }): Promise<PendingGoogleAuthorization | null> {
    const stored = await this.#store.takePending(input);
    return stored === null
      ? null
      : {
          ...stored,
          pkce_verifier: this.#open(
            { table: 'google_oauth_pending', owner: stored, field: 'pkce_verifier' },
            stored.pkce_verifier,
          ),
          client_secret: this.#open(
            { table: 'google_oauth_pending', owner: stored, field: 'client_secret' },
            stored.client_secret,
          ),
        };
  }

  hasPending(owner: GoogleOwner): Promise<boolean> {
    return this.#store.hasPending(owner);
  }

  clearPending(owner: GoogleOwner): Promise<void> {
    return this.#store.clearPending(owner);
  }

  purgeExpiredPending(): Promise<void> {
    return this.#store.purgeExpiredPending();
  }

  /**
   * The wrapped store matches the expected refresh token against what it holds, and each
   * encryption of one token differs. So the token is compared after decrypting, and the stored
   * form is handed on, which keeps the wrapped store's check atomic.
   */
  async #storedVersion(input: {
    owner: GoogleOwner;
    expected: GoogleConnectionVersion;
  }): Promise<GoogleConnectionVersion | undefined> {
    const stored = await this.#store.get(input.owner);
    if (stored === null || this.#openConnection(stored).refresh_token !== input.expected.refresh_token) {
      return undefined;
    }
    return { refresh_token: stored.refresh_token, updated_at: input.expected.updated_at };
  }

  #openConnection(stored: GoogleConnectionRecord): GoogleConnectionRecord {
    return {
      ...stored,
      client_secret: this.#open(
        { table: 'google_connection', owner: stored, field: 'client_secret' },
        stored.client_secret,
      ),
      refresh_token: this.#open(
        { table: 'google_connection', owner: stored, field: 'refresh_token' },
        stored.refresh_token,
      ),
    };
  }

  #seal(where: { table: SecretTable; owner: GoogleOwner; field: string }, plaintext: string): string {
    return this.#vault.encrypt({ plaintext, context: context(where) });
  }

  #open(where: { table: SecretTable; owner: GoogleOwner; field: string }, value: string): string {
    return isEncryptedSecret(value) ? this.#vault.decrypt({ value, context: context(where) }) : value;
  }
}
