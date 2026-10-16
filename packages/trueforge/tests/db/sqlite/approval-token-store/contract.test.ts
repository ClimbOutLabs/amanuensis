import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import { SqliteApprovalTokenStore } from '../../../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { runApprovalTokenStoreContractSuite } from '../../approvalTokenStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const alice = { tenant_id: 't1', created_by: 'alice' };
const mintInput = {
  ...alice,
  action_id: 'act-1',
  canonical_params: { a: 1 },
  expires_at: new Date(Date.now() + 60_000).toISOString(),
};

describe('SqliteApprovalTokenStore (ApprovalTokenStore contract)', () => {
  let env: SqliteTestDatabase;
  let peerDb: ReturnType<typeof createSqliteDb>;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    peerDb = createSqliteDb(env.databaseFile);
  }, 120_000);

  afterEach(async () => {
    await peerDb?.destroy();
    await env?.teardown();
  });

  runApprovalTokenStoreContractSuite(() => ({
    store: () => new SqliteApprovalTokenStore(env.db),
    peer: () => new SqliteApprovalTokenStore(peerDb),
    countRows: async () => {
      const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM approval_token`.execute(env.db);
      return rows[0]?.n ?? 0;
    },
  }));

  it('keeps only the sha256 of the token id', async () => {
    const minted = await new SqliteApprovalTokenStore(env.db).mint(mintInput);

    const rows = await env.db.selectFrom('approval_token').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(createHash('sha256').update(minted.token_id).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(minted.token_id);
  });

  it('a token minted by one connection redeems on a fresh one, once', async () => {
    const minted = await new SqliteApprovalTokenStore(env.db).mint(mintInput);

    const reopened = createSqliteDb(env.databaseFile);
    try {
      const store = new SqliteApprovalTokenStore(reopened);
      expect(await store.redeem({ ...alice, token_id: minted.token_id })).toEqual(minted);
      expect(await store.redeem({ ...alice, token_id: minted.token_id })).toBeUndefined();
    } finally {
      await reopened.destroy();
    }
  });

  it('fails closed when the database errors', async () => {
    const store = new SqliteApprovalTokenStore(env.db);
    const minted = await store.mint(mintInput);
    await sql`DROP TABLE approval_token`.execute(env.db);

    await expect(store.redeem({ ...alice, token_id: minted.token_id })).rejects.toThrow();
    await expect(store.mint(mintInput)).rejects.toThrow();
  });
});
