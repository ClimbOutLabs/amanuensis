import type {
  GoogleConnectionRecord,
  PendingGoogleAuthorization,
} from '@truefoundry/trueforge-core/core/google/connection';
import { sql } from 'kysely';

import { SqliteGoogleConnectionStore } from '../../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { EncryptedGoogleConnectionStore } from '../../../../src/secrets/encryptedGoogleConnectionStore';
import { SecretDecryptError } from '../../../../src/secrets/secretCipher';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runGoogleConnectionStoreContractSuite } from '../../googleConnectionStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const OWNER = { tenant_id: 'tenant-a', created_by: 'user-a' };
const SECRET_CANARY = 'gcs-canary-41d7f0a2b8';
const REFRESH_CANARY = 'grt-canary-9e03c5d16f';
const VERIFIER_CANARY = 'gpv-canary-2b8a6f4e70';
const UPDATED_AT = '2026-10-15T10:00:00.000Z';

const connection: GoogleConnectionRecord = {
  ...OWNER,
  client_id: '123456789-abcdefghij.apps.googleusercontent.com',
  client_secret: SECRET_CANARY,
  client_type: 'desktop',
  refresh_token: REFRESH_CANARY,
  granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  account_email: null,
  status: 'connected',
  created_at: UPDATED_AT,
  updated_at: UPDATED_AT,
};
const pending: PendingGoogleAuthorization = {
  ...OWNER,
  state_hash: 'hash-1',
  pkce_verifier: VERIFIER_CANARY,
  client_id: connection.client_id,
  client_secret: SECRET_CANARY,
  client_type: 'desktop',
  redirect_uri: 'http://127.0.0.1:8790/callback',
  scopes: connection.granted_scopes,
  created_at: new Date().toISOString(),
};

describe('EncryptedGoogleConnectionStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: SqliteGoogleConnectionStore;
  let vault: SecretVault;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new SqliteGoogleConnectionStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runGoogleConnectionStoreContractSuite(() => new EncryptedGoogleConnectionStore({ store: inner, vault }));

  it('round-trips the connection and a sign-in in progress without writing secrets to the database files', async () => {
    const store = new EncryptedGoogleConnectionStore({ store: inner, vault });
    await store.save(connection);
    await store.savePending(pending);
    expect(await store.get(OWNER)).toEqual(connection);
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    for (const needle of [SECRET_CANARY, REFRESH_CANARY, VERIFIER_CANARY]) {
      expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle })).toBe(false);
    }
    expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).toEqual(pending);
  });

  it('updates only when the expected refresh token is the one saved', async () => {
    const store = new EncryptedGoogleConnectionStore({ store: inner, vault });
    await store.save(connection);
    const stale = { refresh_token: 'another-token', updated_at: UPDATED_AT };
    expect(await store.markNeedsReconnect({ owner: OWNER, expected: stale })).toBe(false);
    expect(
      await store.setAccountEmail({
        owner: OWNER,
        expected: { refresh_token: REFRESH_CANARY, updated_at: UPDATED_AT },
        account_email: 'ada@example.com',
        updated_at: '2026-10-16T10:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      await store.markNeedsReconnect({
        owner: OWNER,
        expected: { refresh_token: REFRESH_CANARY, updated_at: '2026-10-16T10:00:00.000Z' },
      }),
    ).toBe(true);
    expect(await store.get(OWNER)).toMatchObject({ status: 'needs_reconnect', refresh_token: REFRESH_CANARY });
  });

  it("refuses one person's refresh token copied to another person", async () => {
    const store = new EncryptedGoogleConnectionStore({ store: inner, vault });
    await store.save(connection);
    const raw = await inner.get(OWNER);
    if (raw === null) {
      throw new Error('connection missing');
    }
    await inner.save({ ...raw, created_by: 'user-b' });
    await expect(store.get({ ...OWNER, created_by: 'user-b' })).rejects.toThrow(SecretDecryptError);
  });

  it('reads a connection saved before encryption; while locked reads and saves nothing', async () => {
    await inner.save(connection);
    const store = new EncryptedGoogleConnectionStore({ store: inner, vault });
    expect(await store.get(OWNER)).toEqual(connection);
    await store.save(connection);

    const locked = new EncryptedGoogleConnectionStore({ store: inner, vault: await createLockedVault(env.db) });
    await expect(locked.get(OWNER)).rejects.toThrow(SecretsLockedError);
    await expect(locked.save({ ...connection, created_by: 'user-b' })).rejects.toThrow(SecretsLockedError);
    await expect(locked.savePending(pending)).rejects.toThrow(SecretsLockedError);
    expect(await locked.listConnectedOwners()).toEqual([OWNER]);
  });
});
