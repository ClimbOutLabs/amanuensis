import {
  flattenProviderModels,
  type CreateModelProviderInput,
  type GetModelProviderForUpdateInput,
  type GetModelProviderInput,
  type IModelProviderStore,
  type ListModelProvidersInput,
  type ModelProviderRecord,
  type RecordModelProviderCheckInput,
  type UpsertModelProviderInput,
} from '../db/modelProviderStore';
import type { AvailableModel, ModelProviderManifest } from '../schemas/modelProvider';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

function apiKeyContext({ tenant_id, name }: { tenant_id: string; name: string }): SecretContext {
  return { table: 'model_provider', primary_key: JSON.stringify([tenant_id, name]), field: 'manifest.auth.api_key' };
}

/**
 * Keeps each provider's API key encrypted in the wrapped store. Callers pass and get the real key;
 * only the encrypted form reaches the database. A key saved before encryption is read as it is
 * until it is encrypted in place.
 */
export class EncryptedModelProviderStore<TTransaction = never> implements IModelProviderStore<TTransaction> {
  readonly #store: IModelProviderStore<TTransaction>;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: IModelProviderStore<TTransaction>; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  get managedElsewhere(): boolean {
    return this.#store.managedElsewhere;
  }

  async listProviders(input: ListModelProvidersInput, transaction?: TTransaction): Promise<ModelProviderRecord[]> {
    return (await this.#store.listProviders(input, transaction)).map(record => this.#open(record));
  }

  async getProvider(
    input: GetModelProviderInput,
    transaction?: TTransaction,
  ): Promise<ModelProviderRecord | undefined> {
    return this.#openIfFound(await this.#store.getProvider(input, transaction));
  }

  async getProviderForUpdate(
    input: GetModelProviderForUpdateInput,
    transaction: TTransaction,
  ): Promise<ModelProviderRecord | undefined> {
    return this.#openIfFound(await this.#store.getProviderForUpdate(input, transaction));
  }

  async createProvider(input: CreateModelProviderInput, transaction?: TTransaction): Promise<ModelProviderRecord> {
    return this.#open(await this.#store.createProvider(this.#sealInput(input), transaction));
  }

  async upsertProvider(input: UpsertModelProviderInput, transaction?: TTransaction): Promise<ModelProviderRecord> {
    return this.#open(await this.#store.upsertProvider(this.#sealInput(input), transaction));
  }

  async recordProviderCheck(
    input: RecordModelProviderCheckInput,
    transaction?: TTransaction,
  ): Promise<ModelProviderRecord | undefined> {
    return this.#openIfFound(await this.#store.recordProviderCheck(input, transaction));
  }

  async listModels(input: ListModelProvidersInput, transaction?: TTransaction): Promise<AvailableModel[]> {
    // Model names need no key, so this works while secrets are locked.
    return flattenProviderModels(await this.#store.listProviders(input, transaction));
  }

  deleteProvider(input: GetModelProviderInput, transaction?: TTransaction): Promise<boolean> {
    return this.#store.deleteProvider(input, transaction);
  }

  #sealInput(input: CreateModelProviderInput): CreateModelProviderInput {
    return {
      ...input,
      manifest: this.#withApiKey(input, key => this.#vault.encrypt({ plaintext: key, context: apiKeyContext(input) })),
    };
  }

  #open(record: ModelProviderRecord): ModelProviderRecord {
    return {
      ...record,
      manifest: this.#withApiKey(record, key =>
        isEncryptedSecret(key) ? this.#vault.decrypt({ value: key, context: apiKeyContext(record) }) : key,
      ),
    };
  }

  #openIfFound(record: ModelProviderRecord | undefined): ModelProviderRecord | undefined {
    return record === undefined ? undefined : this.#open(record);
  }

  #withApiKey(
    { manifest }: { manifest: ModelProviderManifest },
    change: (apiKey: string) => string,
  ): ModelProviderManifest {
    return manifest.auth === undefined
      ? manifest
      : { ...manifest, auth: { ...manifest.auth, api_key: change(manifest.auth.api_key) } };
  }
}
