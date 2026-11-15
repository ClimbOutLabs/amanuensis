import { SqliteLocalUserStore } from '../../../../src/db/sqlite/local-user-store/SqliteLocalUserStore';
import { runLocalUserStoreContractSuite } from '../../localUserStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('LocalUserStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runLocalUserStoreContractSuite(() => new SqliteLocalUserStore(env.db));
});
