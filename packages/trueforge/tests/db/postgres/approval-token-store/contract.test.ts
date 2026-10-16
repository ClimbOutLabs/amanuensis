import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import { PostgresApprovalTokenStore } from '../../../../src/db/postgres/approval-token-store/PostgresApprovalTokenStore';
import { runApprovalTokenStoreContractSuite } from '../../approvalTokenStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresApprovalTokenStore (ApprovalTokenStore contract)', () => {
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
      await sql`TRUNCATE TABLE approval_token`.execute(env.db);
    }
  });

  function database(): PostgresTestDatabase {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return env;
  }

  // Parallel redeems check out different pooled connections, so one store is also a concurrent one.
  runApprovalTokenStoreContractSuite(() => ({
    store: () => new PostgresApprovalTokenStore(database().db),
    peer: () => new PostgresApprovalTokenStore(database().db),
    countRows: async () => {
      const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM approval_token`.execute(database().db);
      return Number(rows[0]?.n ?? 0);
    },
  }));

  it('keeps only the sha256 of the token id', async () => {
    const minted = await new PostgresApprovalTokenStore(database().db).mint({
      tenant_id: 't1',
      created_by: 'alice',
      action_id: 'act-1',
      canonical_params: { a: 1 },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const rows = await database().db.selectFrom('approval_token').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(minted.token_id).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(minted.token_id);
  });
});
