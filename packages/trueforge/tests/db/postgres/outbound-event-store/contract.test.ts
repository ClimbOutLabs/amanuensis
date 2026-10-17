import { sql } from 'kysely';

import { PostgresOutboundEventStore } from '../../../../src/db/postgres/outbound-event-store/PostgresOutboundEventStore';
import { runOutboundEventStoreContractSuite } from '../../outboundEventStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresOutboundEventStore (IOutboundEventStore contract)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE outbound_event`.execute(env.db);
    }
  });

  runOutboundEventStoreContractSuite(now => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return new PostgresOutboundEventStore(env.db, now);
  });
});
