import { sql } from 'kysely';

import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { runSentinelAuditHeldSearchContractSuite } from '../../sentinelAuditHeldSearchContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('SentinelAuditStore on Postgres: held web searches', () => {
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
      await sql`TRUNCATE TABLE sentinel_audit`.execute(env.db);
    }
  });

  runSentinelAuditHeldSearchContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable');
    }
    return new SentinelAuditStore(env.db);
  });
});
