import { PhoneCallStore } from '../../../../src/db/phoneCallStore';
import { runPhoneCallStoreContractSuite } from '../../phoneCallStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('PhoneCallStore on SQLite (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runPhoneCallStoreContractSuite(() => new PhoneCallStore(env.db));
});
