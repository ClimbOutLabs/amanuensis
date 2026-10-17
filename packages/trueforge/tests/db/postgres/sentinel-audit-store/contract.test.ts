import { sql } from 'kysely';

import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { runSentinelAuditStoreContractSuite } from '../../sentinelAuditStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('SentinelAuditStore on Postgres (ISentinelAuditStore contract)', () => {
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
      await sql`TRUNCATE TABLE sentinel_audit, session CASCADE`.execute(env.db);
    }
  });

  runSentinelAuditStoreContractSuite(() => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return { store: new SentinelAuditStore(env.db), sessions: new PostgresSessionStore(env.db) };
  });
});
