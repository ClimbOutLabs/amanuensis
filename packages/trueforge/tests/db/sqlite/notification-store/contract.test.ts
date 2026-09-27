import { SqliteNotificationStore } from '../../../../src/db/sqlite/notification-store/SqliteNotificationStore';
import { runNotificationStoreContractSuite } from '../../notificationStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteNotificationStore (contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runNotificationStoreContractSuite(() => new SqliteNotificationStore(env.db));
});
