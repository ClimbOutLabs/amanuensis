import { TextContactStore } from '../../../../src/db/textContactStore';
import { runTextContactStoreContractSuite } from '../../textContactStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('TextContactStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runTextContactStoreContractSuite(() => new TextContactStore(env.db));
});
