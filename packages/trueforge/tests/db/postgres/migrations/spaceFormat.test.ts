/**
 * `20260913_000001_space` shipped (build fe3d8653) before `format` existed. Applying it alone
 * must still create a table with the pre-#186 shape, and applying `20260914_000001_space_format`
 * on top of an already-populated table must backfill `format` to `markdown` on the existing row.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { ulid } from 'ulid';

import { createDb } from '../../../../src/db/postgres/client';
import { ensureTrueforgeSchema } from '../../../../src/db/postgres/schema';
import type { Database } from '../../../../src/db/postgres/types';

const ADMIN_URL_ENV = 'PG_STORE_TESTS_ADMIN_URL';
const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

function withDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString.replace(/^postgres:/, 'http:'));
  parsed.pathname = `/${database}`;
  return parsed.toString().replace(/^http:/, 'postgres:');
}

async function dropDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await pool.end();
  }
}

function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    allowUnorderedMigrations: true,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, '..', '..', '..', '..', 'src', 'db', 'postgres', 'migrations'),
    }),
  });
}

describePg('20260914_000001_space_format migration', () => {
  let adminUrl: string;
  let databaseName: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    const url = process.env[ADMIN_URL_ENV];
    if (url === undefined || url === '') {
      throw new Error(`${ADMIN_URL_ENV} unavailable despite globalSetup probe`);
    }
    adminUrl = url;
    databaseName = `test_${ulid().toLowerCase()}`;

    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminPool.end();
    }

    db = createDb({
      connectionString: withDatabase(adminUrl, databaseName),
      poolMax: 5,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
    });
    // createDb pins search_path to the trueforge schema; the app creates that schema before it
    // migrates, so a fresh database needs the same bootstrap before any migration can create a table.
    await ensureTrueforgeSchema(db);
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await dropDatabase(adminUrl, databaseName);
  });

  it('backfills format to markdown for a row created before the column existed', async () => {
    const migrator = createMigrator(db);

    const toSpaceOnly = await migrator.migrateTo('20260913_000001_space');
    expect(toSpaceOnly.error).toBeUndefined();

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO space (tenant_id, created_by, id, name, purpose, status, body, revision, created_at, updated_at)
      VALUES ('default', 'user-a', 's-legacy', 'Legacy space', 'Pre-format row', 'active', '', 1, ${timestamp}::timestamptz, ${timestamp}::timestamptz)
    `.execute(db);

    const toLatest = await migrator.migrateToLatest();
    expect(toLatest.error).toBeUndefined();

    const row = await db.selectFrom('space').selectAll().where('id', '=', 's-legacy').executeTakeFirstOrThrow();
    expect(row.format).toBe('markdown');
  });
});
