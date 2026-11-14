import { sql } from 'kysely';

import { TelegramStore, type SaveTelegramConnectionInput } from '../../../../src/db/telegramStore';
import { EncryptedTelegramStore } from '../../../../src/secrets/encryptedTelegramStore';
import { SecretsLockedError, type SecretVault } from '../../../../src/secrets/secretVault';
import { runTelegramStoreContractSuite } from '../../telegramStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';
import { createLockedVault, createUnlockedVault, databaseFilesContain } from './testVault';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const TOKEN_CANARY = '4242:tg-canary-7d1e90b3a6';
const WEBHOOK_CANARY = 'wh-canary-5f28c4a17e';

function bot(owner: { tenant_id: string; created_by: string }, webhook_secret: string): SaveTelegramConnectionInput {
  return {
    ...owner,
    created_by_subject: { subject_id: owner.created_by, subject_type: 'owner', subject_display_name: 'Owner' },
    bot_token: TOKEN_CANARY,
    bot_id: '4242',
    bot_name: 'Test Bot',
    bot_username: 'test_bot',
    transport: 'webhook',
    webhook_secret,
  };
}

describe('EncryptedTelegramStore on SQLite', () => {
  let env: SqliteTestDatabase;
  let inner: TelegramStore;
  let vault: SecretVault;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    inner = new TelegramStore(env.db);
    vault = await createUnlockedVault(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runTelegramStoreContractSuite(() => new EncryptedTelegramStore({ store: inner, vault }));

  it('round-trips the bot token and finds a connection by its webhook secret, without writing either to the database files', async () => {
    const store = new EncryptedTelegramStore({ store: inner, vault });
    const alice = await store.saveConnection(bot(ALICE, WEBHOOK_CANARY));
    const bob = await store.saveConnection(bot(BOB, 'wh-other-secret-000'));
    expect(alice.bot_token).toBe(TOKEN_CANARY);
    expect((await store.getConnection(ALICE))?.bot_token).toBe(TOKEN_CANARY);
    expect((await store.getConnectionByWebhookSecret({ webhook_secret: WEBHOOK_CANARY }))?.id).toBe(alice.id);
    expect((await store.getConnectionByWebhookSecret({ webhook_secret: 'wh-other-secret-000' }))?.id).toBe(bob.id);
    expect(await store.getConnectionByWebhookSecret({ webhook_secret: 'not-a-secret' })).toBeUndefined();

    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(env.db);
    for (const needle of [TOKEN_CANARY, WEBHOOK_CANARY]) {
      expect(await databaseFilesContain({ databaseFile: env.databaseFile, needle })).toBe(false);
    }
  });

  it('never matches a webhook request that sends the stored encrypted form', async () => {
    const store = new EncryptedTelegramStore({ store: inner, vault });
    await store.saveConnection(bot(ALICE, WEBHOOK_CANARY));
    const raw = await inner.getConnection(ALICE);
    expect(raw?.webhook_secret).not.toBe(WEBHOOK_CANARY);
    expect(await store.getConnectionByWebhookSecret({ webhook_secret: raw?.webhook_secret ?? '' })).toBeUndefined();
  });

  it('reads a connection saved before encryption; while locked reads and saves nothing', async () => {
    await inner.saveConnection(bot(ALICE, WEBHOOK_CANARY));
    const store = new EncryptedTelegramStore({ store: inner, vault });
    expect((await store.getConnection(ALICE))?.bot_token).toBe(TOKEN_CANARY);
    expect(await store.getConnectionByWebhookSecret({ webhook_secret: WEBHOOK_CANARY })).toBeDefined();
    await store.saveConnection(bot(ALICE, WEBHOOK_CANARY));

    const locked = new EncryptedTelegramStore({ store: inner, vault: await createLockedVault(env.db) });
    await expect(locked.getConnection(ALICE)).rejects.toThrow(SecretsLockedError);
    await expect(locked.listConnections()).rejects.toThrow(SecretsLockedError);
    await expect(locked.saveConnection(bot(BOB, 'x'))).rejects.toThrow(SecretsLockedError);
  });
});
