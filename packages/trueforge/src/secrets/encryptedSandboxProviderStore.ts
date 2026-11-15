import { isDeepStrictEqual } from 'node:util';

import type {
  ISandboxProviderStore,
  SandboxProviderRecord,
  UpdateSandboxStatusInput,
  UpsertSandboxProviderInput,
} from '../db/sandboxProviderStore';
import type { StoredSandboxProviderManifest } from '../schemas/sandboxProvider';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

function apiKeyContext(tenantId: string): SecretContext {
  return { table: 'sandbox_provider', primary_key: tenantId, field: 'manifest.auth.api_key' };
}

/**
 * Keeps the sandbox provider's API key encrypted in the wrapped store. Callers pass and get the
 * real key. A key saved before encryption is read as it is until it is encrypted in place.
 */
export class EncryptedSandboxProviderStore<TTransaction = never> implements ISandboxProviderStore<TTransaction> {
  readonly #store: ISandboxProviderStore<TTransaction>;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: ISandboxProviderStore<TTransaction>; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  async getSandboxProvider(tenantId: string, transaction?: TTransaction): Promise<SandboxProviderRecord | undefined> {
    return this.#openIfFound(await this.#store.getSandboxProvider(tenantId, transaction));
  }

  async getSandboxProviderForUpdate(
    tenantId: string,
    transaction: TTransaction,
  ): Promise<SandboxProviderRecord | undefined> {
    return this.#openIfFound(await this.#store.getSandboxProviderForUpdate(tenantId, transaction));
  }

  async upsertSandboxProvider(
    input: UpsertSandboxProviderInput,
    transaction?: TTransaction,
  ): Promise<SandboxProviderRecord> {
    const manifest = this.#withApiKey(input.manifest, key =>
      this.#vault.encrypt({ plaintext: key, context: apiKeyContext(input.tenant_id) }),
    );
    return this.#open(await this.#store.upsertSandboxProvider({ ...input, manifest }, transaction));
  }

  async updateSandboxStatus(
    input: UpdateSandboxStatusInput,
    transaction?: TTransaction,
  ): Promise<SandboxProviderRecord | undefined> {
    if (input.expected_manifest === undefined) {
      return this.#openIfFound(await this.#store.updateSandboxStatus(input, transaction));
    }
    // Each encryption of the same key differs, so the expected manifest is matched after decrypting,
    // and the stored form is what the wrapped store compares against, keeping its check atomic.
    const stored = await this.#store.getSandboxProvider(input.tenant_id, transaction);
    if (stored === undefined || !isDeepStrictEqual(this.#open(stored).manifest, input.expected_manifest)) {
      return undefined;
    }
    return this.#openIfFound(
      await this.#store.updateSandboxStatus({ ...input, expected_manifest: stored.manifest }, transaction),
    );
  }

  #open(record: SandboxProviderRecord): SandboxProviderRecord {
    return {
      ...record,
      manifest: this.#withApiKey(record.manifest, key =>
        isEncryptedSecret(key) ? this.#vault.decrypt({ value: key, context: apiKeyContext(record.tenant_id) }) : key,
      ),
    };
  }

  #openIfFound(record: SandboxProviderRecord | undefined): SandboxProviderRecord | undefined {
    return record === undefined ? undefined : this.#open(record);
  }

  #withApiKey(
    manifest: StoredSandboxProviderManifest,
    change: (apiKey: string) => string,
  ): StoredSandboxProviderManifest {
    return manifest.type === 'daytona'
      ? { ...manifest, auth: { ...manifest.auth, api_key: change(manifest.auth.api_key) } }
      : manifest;
  }
}
