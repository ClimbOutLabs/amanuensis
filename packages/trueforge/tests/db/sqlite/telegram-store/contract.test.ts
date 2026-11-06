import { TelegramStore } from '../../../../src/db/telegramStore';
import { runTelegramStoreContractSuite } from '../../telegramStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('TelegramStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runTelegramStoreContractSuite(() => new TelegramStore(env.db));
});
