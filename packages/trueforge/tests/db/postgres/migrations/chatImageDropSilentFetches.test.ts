/**
 * `20261021_000001_chat_image_drop_silent_fetches` removes the silent-fetch counter and the
 * `remote_silent` origin. A database migrated with the earlier chat image migration must end with
 * the same schema as a fresh one, keep the images people can see, and roll back cleanly.
 */
import { sql } from 'kysely';

import { migrateTo, migrateToLatest } from '../../../../src/db/migratePostgres';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;
const PREVIOUS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

type Db = PostgresTestDatabase['db'];

async function insertSession(db: Db): Promise<void> {
  await sql`
    INSERT INTO session (
      tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
      last_activity_timestamp_ms, created_at, updated_at
    )
    VALUES (
      't1', 's1', '{"subject_id":"alice","subject_type":"user"}'::jsonb, '{}'::jsonb, '[]'::jsonb,
      0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
    )
  `.execute(db);
}

async function insertImage(db: Db, imageId: string, origin: string): Promise<void> {
  await sql`
    INSERT INTO chat_image (
      tenant_id, created_by, session_id, turn_id, image_id, source_key,
      origin, mime, width, height, size, data, created_at
    )
    VALUES (
      't1', 'alice', 's1', 'turn1', ${imageId}, ${`source-${imageId}`},
      ${origin}, 'image/png', 1, 1, 3, ${Buffer.from([1, 2, 3])}, '2026-10-01T00:00:00.000Z'
    )
  `.execute(db);
}

async function imageIds(db: Db): Promise<string[]> {
  const { rows } = await sql<{ image_id: string }>`SELECT image_id FROM chat_image ORDER BY image_id`.execute(db);
  return rows.map(row => row.image_id);
}

async function chatImageTables(db: Db): Promise<string[]> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name LIKE 'chat\_image%'
    ORDER BY table_name
  `.execute(db);
  return rows.map(row => row.table_name);
}

// Compares the definitions the database itself reports, so a rebuilt-in-place table is judged by what it enforces.
async function chatImageSchema(db: Db): Promise<unknown> {
  const tables = await chatImageTables(db);
  const columns = await sql`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'chat_image'
    ORDER BY column_name
  `.execute(db);
  const constraints = await sql`
    SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'chat_image'::regclass ORDER BY conname
  `.execute(db);
  const indexes = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'chat_image' ORDER BY indexname
  `.execute(db);
  return { tables, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

describePg('Postgres chat image drop-silent-fetches migration', () => {
  let env: PostgresTestDatabase | undefined;
  let fresh: PostgresTestDatabase | undefined;

  beforeEach(async () => {
    env = await createPostgresTestDatabase(PREVIOUS_MIGRATION);
    fresh = await createPostgresTestDatabase();
    if (env === undefined || fresh === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
    await fresh?.teardown();
  });

  function migratedEnv(): PostgresTestDatabase {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return env;
  }

  it('keeps the images people can see, drops silent ones, and removes the turn allowance table', async () => {
    const { db } = migratedEnv();
    await insertSession(db);
    await insertImage(db, 'local-image', 'local');
    await insertImage(db, 'approved-image', 'remote_approved');
    await insertImage(db, 'silent-image', 'remote_silent');
    await sql`
      INSERT INTO chat_image_turn_allowance (tenant_id, session_id, turn_id, silent_attempts)
      VALUES ('t1', 's1', 'turn1', 2)
    `.execute(db);

    await migrateToLatest(db);

    expect(await imageIds(db)).toEqual(['approved-image', 'local-image']);
    expect(await chatImageTables(db)).toEqual(['chat_image']);
  });

  it('ends with the same schema as a fresh database', async () => {
    const { db } = migratedEnv();
    await insertSession(db);
    await insertImage(db, 'silent-image', 'remote_silent');
    await migrateToLatest(db);

    if (fresh === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    expect(await chatImageSchema(db)).toEqual(await chatImageSchema(fresh.db));
  });

  it('rejects the silent origin once the migration has run', async () => {
    const { db } = migratedEnv();
    await migrateToLatest(db);
    await insertSession(db);

    await expect(insertImage(db, 'silent-image', 'remote_silent')).rejects.toThrow();
    await expect(insertImage(db, 'approved-image', 'remote_approved')).resolves.toBeUndefined();
  });

  it('rolls back to the previous schema and keeps the images that remain', async () => {
    const { db } = migratedEnv();
    await migrateToLatest(db);
    await insertSession(db);
    await insertImage(db, 'approved-image', 'remote_approved');

    await migrateTo(db, PREVIOUS_MIGRATION);

    expect(await chatImageTables(db)).toEqual(['chat_image', 'chat_image_turn_allowance']);
    expect(await imageIds(db)).toEqual(['approved-image']);
    await expect(insertImage(db, 'silent-image', 'remote_silent')).resolves.toBeUndefined();
  });
});
