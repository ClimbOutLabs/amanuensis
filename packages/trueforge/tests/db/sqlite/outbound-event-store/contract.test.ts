import { SqliteOutboundEventStore } from '../../../../src/db/sqlite/outbound-event-store/SqliteOutboundEventStore';
import { runOutboundEventStoreContractSuite } from '../../outboundEventStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteOutboundEventStore (IOutboundEventStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  runOutboundEventStoreContractSuite(now => new SqliteOutboundEventStore(env.db, now));
});
