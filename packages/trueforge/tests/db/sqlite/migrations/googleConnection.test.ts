/**
 * `20261016_000003_google_connection` adds the two Google tables. Rolling it back must remove both, and
 * running it again must start from empty tables.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261011_000001_sentinel_search_without_asking';
const THIS_MIGRATION = '20261016_000003_google_connection';

async function createMigrator(db: Kysely<Database>): Promise<Migrator> {
  return new Migrator({
    db,
    allowUnorderedMigrations: true,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, '..', '..', '..', '..', 'src', 'db', 'sqlite', 'migrations'),
    }),
  });
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'google_%' ORDER BY name
  `.execute(db);
  return rows.map(row => row.name);
}

describe('20261016_000003_google_connection migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-google-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates both tables and removes both when rolled back', async () => {
    const migrator = await createMigrator(db);
    // Stop at this migration so rolling back undoes only it, whatever lands after it.
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();
    expect(await tableNames(db)).toEqual(['google_connection', 'google_oauth_pending']);

    const rolledBack = await migrator.migrateTo(PREVIOUS_MIGRATION);
    expect(rolledBack.error).toBeUndefined();
    expect(await tableNames(db)).toEqual([]);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await tableNames(db)).toEqual(['google_connection', 'google_oauth_pending']);
  });

  it('keeps one login and one pending consent per user', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const stamp = new Date().toISOString();
    const insert = () =>
      sql`
        INSERT INTO google_connection (tenant_id, created_by, client_id, client_secret, client_type, refresh_token,
          granted_scopes, status, created_at, updated_at)
        VALUES ('t1', 'u1', 'id', 'secret', 'desktop', 'rt', '[]', 'connected', ${stamp}, ${stamp})
      `.execute(db);
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
