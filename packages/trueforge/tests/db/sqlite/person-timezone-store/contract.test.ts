import { PersonTimezoneStore } from '../../../../src/db/personTimezoneStore';
import { runPersonTimezoneStoreContractSuite } from '../../personTimezoneStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('PersonTimezoneStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runPersonTimezoneStoreContractSuite(() => new PersonTimezoneStore(env.db));
});
