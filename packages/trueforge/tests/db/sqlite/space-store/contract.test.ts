import { SqliteSpaceStore } from '../../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { runSpaceStoreContractSuite } from '../../spaceStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSpaceStore (ISpaceStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSpaceStoreContractSuite(() => new SqliteSpaceStore(env.db));
});
