import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { runSentinelAuditStoreContractSuite } from '../../sentinelAuditStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SentinelAuditStore on SQLite (ISentinelAuditStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSentinelAuditStoreContractSuite(() => ({
    store: new SentinelAuditStore(env.db),
    sessions: new SqliteSessionStore(env.db),
  }));
});
