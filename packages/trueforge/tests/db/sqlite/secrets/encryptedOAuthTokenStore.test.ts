import { sql } from 'kysely';

import { jsonbBind, nowIso } from '../../../../src/db/sqlite/sqlExpressions';
import { SqliteOAuthTokenStore } from '../../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { OAuthToken } from '../../../../src/mcp/auth/types';
import type { McpServerManifest } from '../../../../src/schemas/mcpServer';
import { EncryptedOAuthTokenStore } from '../../../../src/secrets/encryptedOAuthTokenStore';
import { SecretDecryptError } from '../../../../src/secrets/secretCipher';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runOAuthTokenStoreContractSuite, type OAuthTokenStoreHarness } from '../../oauthTokenStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const ACCESS_CANARY = 'at-canary-0d19e7b3c5';
const REFRESH_CANARY = 'rt-canary-6c2f48a0e9';
const token: OAuthToken = {
  accessToken: ACCESS_CANARY,
  refreshToken: REFRESH_CANARY,
  expiresAt: '2099-01-01T00:00:00.000Z',
  scope: 'read',
};

describe('EncryptedOAuthTokenStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: SqliteOAuthTokenStore;
  let vault: SecretVault;

  async function seedResource(id: string): Promise<void> {
    const manifest: McpServerManifest = {
      type: 'remote',
      name: id,
      url: 'https://mcp.example.com/sse',
      description: 'Test MCP server.',
    };
    await env.db
      .insertInto('mcp_server')
      .values({
        id,
        tenant_id: 'default',
        name: id,
        manifest: jsonbBind(manifest),
        oauth_server: null,
        oauth_client: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      .execute();
  }

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new SqliteOAuthTokenStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runOAuthTokenStoreContractSuite((): OAuthTokenStoreHarness => ({
    store: new EncryptedOAuthTokenStore({ store: inner, vault }),
    seedResource,
    async expirePending(state) {
      await env.db
        .updateTable('oauth_pending_authorization')
        .set({ created_at: new Date(Date.now() - 3_600_000).toISOString() })
        .where('id', '=', state)
        .execute();
    },
  }));

  it('round-trips tokens without writing them to the database files', async () => {
    await seedResource('server-1');
    const store = new EncryptedOAuthTokenStore({ store: inner, vault });
    await store.saveToken({ id: 'server-1', userRef: 'user-a', token });
    expect(await store.getToken({ id: 'server-1', userRef: 'user-a' })).toEqual(token);
    expect((await store.getTokens({ ids: ['server-1'], userRef: 'user-a' })).get('server-1')).toEqual(token);
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    for (const needle of [ACCESS_CANARY, REFRESH_CANARY]) {
      expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle })).toBe(false);
    }
  });

  it("refuses one person's token copied to another person", async () => {
    await seedResource('server-1');
    const store = new EncryptedOAuthTokenStore({ store: inner, vault });
    await store.saveToken({ id: 'server-1', userRef: 'user-a', token });
    const raw = await inner.getToken({ id: 'server-1', userRef: 'user-a' });
    if (raw === undefined) {
      throw new Error('token missing');
    }
    await inner.saveToken({ id: 'server-1', userRef: 'user-b', token: raw });
    await expect(store.getToken({ id: 'server-1', userRef: 'user-b' })).rejects.toThrow(SecretDecryptError);
  });

  it('reads a token saved before encryption; while locked reads and saves nothing', async () => {
    await seedResource('server-1');
    await inner.saveToken({ id: 'server-1', userRef: 'user-a', token });
    const store = new EncryptedOAuthTokenStore({ store: inner, vault });
    expect(await store.getToken({ id: 'server-1', userRef: 'user-a' })).toEqual(token);
    await store.saveToken({ id: 'server-1', userRef: 'user-a', token });

    const locked = new EncryptedOAuthTokenStore({ store: inner, vault: await createLockedVault(env.db) });
    await expect(locked.getToken({ id: 'server-1', userRef: 'user-a' })).rejects.toThrow(SecretsLockedError);
    await expect(locked.saveToken({ id: 'server-1', userRef: 'user-b', token })).rejects.toThrow(SecretsLockedError);
  });
});
