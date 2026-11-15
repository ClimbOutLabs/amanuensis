import { NoticingStore } from '../../../../src/db/noticingStore';
import { runNoticingStoreContractSuite } from '../../noticingStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('NoticingStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runNoticingStoreContractSuite(() => new NoticingStore(env.db));
});
