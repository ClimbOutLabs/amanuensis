import { sql } from 'kysely';

import { createDb } from '../../../src/db/postgres/client';
import { TRUEFORGE_SCHEMA } from '../../../src/db/postgres/schema';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

function adminUrl(): string {
  const connectionString = process.env['PG_STORE_TESTS_ADMIN_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('PG_STORE_TESTS_ADMIN_URL unset despite globalSetup probe');
  }
  return connectionString;
}

describePg('createDb postgres session timeouts', () => {
  it('applies statement_timeout and idle_in_transaction_session_timeout on connect', async () => {
    const connectionString = process.env['PG_STORE_TESTS_ADMIN_URL'];
    if (connectionString === undefined || connectionString === '') {
      throw new Error('PG_STORE_TESTS_ADMIN_URL unset despite globalSetup probe');
    }

    // Non-default values so a passing assertion cannot match server defaults (0).
    const statementTimeoutMs = 45_000;
    const idleInTransactionSessionTimeoutMs = 50_000;
    const db = createDb({
      connectionString,
      poolMax: 1,
      statementTimeoutMs,
      idleInTransactionSessionTimeoutMs,
      connectionTimeoutMs: 10_000,
      onIdleClientError: () => undefined,
    });
    try {
      const { rows } = await sql<{ name: string; setting: string }>`
        SELECT name, setting
        FROM pg_settings
        WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout', 'search_path')
      `.execute(db);

      const byName = new Map(rows.map(row => [row.name, row.setting]));
      expect(byName.get('statement_timeout')).toBe(String(statementTimeoutMs));
      expect(byName.get('idle_in_transaction_session_timeout')).toBe(String(idleInTransactionSessionTimeoutMs));
      expect(byName.get('search_path')).toBe(TRUEFORGE_SCHEMA);
    } finally {
      await db.destroy();
    }
  });

  it('waits for a busy pool to free a connection instead of failing at once', async () => {
    const db = createDb({
      connectionString: adminUrl(),
      poolMax: 1,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
      connectionTimeoutMs: 10_000,
      onIdleClientError: () => undefined,
    });
    try {
      // The one connection is busy for a second; the second query queues behind it.
      const slow = sql`SELECT pg_sleep(1)`.execute(db);
      const queued = sql<{ one: number }>`SELECT 1 AS one`.execute(db);
      await slow;
      expect((await queued).rows).toEqual([{ one: 1 }]);
    } finally {
      await db.destroy();
    }
  });

  it('fails a query that waits longer than the connection timeout for a free connection', async () => {
    const db = createDb({
      connectionString: adminUrl(),
      poolMax: 1,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
      connectionTimeoutMs: 200,
      onIdleClientError: () => undefined,
    });
    try {
      await sql`SELECT 1`.execute(db);
      const slow = sql`SELECT pg_sleep(1)`.execute(db);
      await expect(sql`SELECT 1`.execute(db)).rejects.toThrow(/timeout/i);
      await slow;
    } finally {
      await db.destroy();
    }
  });

  it('reports an idle connection that breaks and keeps serving queries', async () => {
    const idleErrors: Error[] = [];
    const db = createDb({
      connectionString: adminUrl(),
      poolMax: 1,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
      connectionTimeoutMs: 10_000,
      onIdleClientError: error => {
        idleErrors.push(error);
      },
    });
    const admin = createDb({
      connectionString: adminUrl(),
      poolMax: 1,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
      connectionTimeoutMs: 10_000,
      onIdleClientError: () => undefined,
    });
    try {
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
      const pid = rows[0]?.pid;
      if (pid === undefined) {
        throw new Error('expected a backend pid');
      }
      // Postgres ends the pooled connection while it sits idle, as on a server restart.
      await sql`SELECT pg_terminate_backend(${pid})`.execute(admin);
      for (let waited = 0; idleErrors.length === 0 && waited < 5_000; waited += 50) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(idleErrors).toHaveLength(1);
      const after = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
      expect(after.rows).toEqual([{ one: 1 }]);
    } finally {
      await db.destroy();
      await admin.destroy();
    }
  });
});
