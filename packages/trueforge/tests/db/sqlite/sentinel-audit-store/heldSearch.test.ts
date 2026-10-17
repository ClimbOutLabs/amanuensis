import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { runSentinelAuditHeldSearchContractSuite } from '../../sentinelAuditHeldSearchContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SentinelAuditStore on SQLite: held web searches', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runSentinelAuditHeldSearchContractSuite(() => new SentinelAuditStore(env.db));
});
