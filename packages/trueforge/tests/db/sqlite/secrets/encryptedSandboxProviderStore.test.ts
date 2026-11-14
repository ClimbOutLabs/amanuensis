import { sql } from 'kysely';

import { SqliteSandboxProviderStore } from '../../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import type { SandboxProviderManifest } from '../../../../src/schemas/sandboxProvider';
import { EncryptedSandboxProviderStore } from '../../../../src/secrets/encryptedSandboxProviderStore';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runSandboxProviderStoreContractSuite } from '../../sandboxProviderStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const CANARY = 'dtn-canary-5be21c9077';
const TENANT = 'default';

const manifest: SandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: CANARY },
  exec_timeout_ms: 60000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};
const saved = { tenant_id: TENANT, manifest, status: 'pending' as const, status_reason: null, build_metadata: null };

describe('EncryptedSandboxProviderStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: SqliteSandboxProviderStore;
  let vault: SecretVault;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new SqliteSandboxProviderStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSandboxProviderStoreContractSuite(() => new EncryptedSandboxProviderStore({ store: inner, vault }));

  it('never writes the key to the database files', async () => {
    const store = new EncryptedSandboxProviderStore({ store: inner, vault });
    await store.upsertSandboxProvider(saved);
    await store.updateSandboxStatus({
      tenant_id: TENANT,
      status: 'ready',
      status_reason: null,
      build_metadata: null,
      expected_manifest: manifest,
    });
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle: CANARY })).toBe(false);
    expect((await store.getSandboxProvider(TENANT))?.status).toBe('ready');
  });

  it('reads a key saved before encryption', async () => {
    await inner.upsertSandboxProvider(saved);
    const store = new EncryptedSandboxProviderStore({ store: inner, vault });
    expect((await store.getSandboxProvider(TENANT))?.manifest).toEqual(manifest);
  });

  it('while locked: saves nothing and reads no key', async () => {
    await new EncryptedSandboxProviderStore({ store: inner, vault }).upsertSandboxProvider(saved);
    const store = new EncryptedSandboxProviderStore({ store: inner, vault: await createLockedVault(env.db) });
    await expect(store.getSandboxProvider(TENANT)).rejects.toThrow(SecretsLockedError);
    await expect(store.upsertSandboxProvider(saved)).rejects.toThrow(SecretsLockedError);
  });
});
