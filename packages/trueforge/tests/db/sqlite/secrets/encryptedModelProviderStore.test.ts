import { sql } from 'kysely';

import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import type { ModelProviderManifest } from '../../../../src/schemas/modelProvider';
import { EncryptedModelProviderStore } from '../../../../src/secrets/encryptedModelProviderStore';
import { SecretDecryptError } from '../../../../src/secrets/secretCipher';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runModelProviderStoreContractSuite } from '../../modelProviderStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const CANARY = 'sk-canary-7f3a9c41d2';
const TENANT = 'default';

const manifest = {
  type: 'openai',
  base_url: 'https://api.openai.com/v1',
  auth: { api_key: CANARY },
  models: [{ model_id: 'gpt-test', name: 'gpt-test', properties: { context_length: 1000, max_output_tokens: 100 } }],
} satisfies ModelProviderManifest;

describe('EncryptedModelProviderStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: SqliteModelProviderStore;
  let vault: SecretVault;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new SqliteModelProviderStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runModelProviderStoreContractSuite(() => new EncryptedModelProviderStore({ store: inner, vault }));

  it('never writes the key to the database files', async () => {
    const store = new EncryptedModelProviderStore({ store: inner, vault });
    await store.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });
    await store.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });

    const raw = await inner.getProvider({ tenant_id: TENANT, name: 'openai', model_name: 'gpt-test' });
    expect(raw?.manifest.auth?.api_key.startsWith('enc:v1:')).toBe(true);
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle: CANARY })).toBe(false);
  });

  it('refuses a key moved to another provider row', async () => {
    const store = new EncryptedModelProviderStore({ store: inner, vault });
    await store.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });
    const raw = await inner.getProvider({ tenant_id: TENANT, name: 'openai', model_name: 'gpt-test' });
    if (raw === undefined) {
      throw new Error('provider missing');
    }
    await inner.upsertProvider({ tenant_id: TENANT, name: 'other', manifest: raw.manifest });
    await expect(store.getProvider({ tenant_id: TENANT, name: 'other', model_name: 'gpt-test' })).rejects.toThrow(
      SecretDecryptError,
    );
  });

  it('reads a key saved before encryption, and encrypts it on the next save', async () => {
    await inner.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });
    const store = new EncryptedModelProviderStore({ store: inner, vault });
    const read = await store.getProvider({ tenant_id: TENANT, name: 'openai', model_name: 'gpt-test' });
    expect(read?.manifest.auth?.api_key).toBe(CANARY);
    await store.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });
    const raw = await inner.getProvider({ tenant_id: TENANT, name: 'openai', model_name: 'gpt-test' });
    expect(raw?.manifest.auth?.api_key).not.toBe(CANARY);
  });

  it('while locked: saves nothing, reads no key, still lists model names', async () => {
    const unlocked = new EncryptedModelProviderStore({ store: inner, vault });
    await unlocked.upsertProvider({ tenant_id: TENANT, name: 'openai', manifest });

    const locked = await createLockedVault(env.db);
    const store = new EncryptedModelProviderStore({ store: inner, vault: locked });
    await expect(store.listProviders({ tenant_id: TENANT })).rejects.toThrow(SecretsLockedError);
    await expect(store.upsertProvider({ tenant_id: TENANT, name: 'anthropic', manifest })).rejects.toThrow(
      SecretsLockedError,
    );
    expect(await inner.listProviders({ tenant_id: TENANT })).toHaveLength(1);
    expect((await store.listModels({ tenant_id: TENANT })).map(model => model.name)).toEqual(['openai/gpt-test']);
  });
});
