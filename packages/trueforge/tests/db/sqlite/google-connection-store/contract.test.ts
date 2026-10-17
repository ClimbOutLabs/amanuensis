import { SqliteGoogleConnectionStore } from '../../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { runGoogleConnectionStoreContractSuite } from '../../googleConnectionStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteGoogleConnectionStore (IGoogleConnectionStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runGoogleConnectionStoreContractSuite(() => new SqliteGoogleConnectionStore(env.db));
});
