import { sql } from 'kysely';

import { ensureTrueforgeSchema, TABLES_TO_MOVE, TRUEFORGE_SCHEMA } from '../../../src/db/postgres/schema';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

interface TableLocation {
  schemaname: string;
  tablename: string;
}

async function schemaOf(env: PostgresTestDatabase, tableName: string): Promise<string[]> {
  const { rows } = await sql<TableLocation>`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE tablename = ${tableName}
      AND schemaname IN ('public', ${TRUEFORGE_SCHEMA})
  `.execute(env.db);
  return rows.map(row => row.schemaname);
}

describePg('ensureTrueforgeSchema', () => {
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

  it('moves every table in TABLES_TO_MOVE into the trueforge schema on a fresh migration', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }

    for (const tableName of TABLES_TO_MOVE) {
      const locations = await schemaOf(env, tableName);
      expect(locations).toEqual([TRUEFORGE_SCHEMA]);
    }
  });

  it('moves a straggler left behind in public without disturbing tables already moved, and is a no-op on rerun', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }

    const strandedTable = 'persona';
    const settledTable = 'agent';

    // Simulate the partial-migration state this function must repair: the
    // trueforge schema already exists (migrateToLatest created it), but one
    // fork table was somehow left behind in public.
    await sql`ALTER TABLE ${sql.id(TRUEFORGE_SCHEMA, strandedTable)} SET SCHEMA public`.execute(env.db);
    expect(await schemaOf(env, strandedTable)).toEqual(['public']);
    expect(await schemaOf(env, settledTable)).toEqual([TRUEFORGE_SCHEMA]);

    await ensureTrueforgeSchema(env.db);

    expect(await schemaOf(env, strandedTable)).toEqual([TRUEFORGE_SCHEMA]);
    expect(await schemaOf(env, settledTable)).toEqual([TRUEFORGE_SCHEMA]);

    // Running it again with nothing stranded must not error and must leave
    // every table exactly where it is.
    await ensureTrueforgeSchema(env.db);

    expect(await schemaOf(env, strandedTable)).toEqual([TRUEFORGE_SCHEMA]);
    expect(await schemaOf(env, settledTable)).toEqual([TRUEFORGE_SCHEMA]);
  });
});
