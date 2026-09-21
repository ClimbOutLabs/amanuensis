/**
 * `20260913_000001_space` shipped (build fe3d8653) before `format` existed. Applying it alone
 * must still create a table with the pre-#186 shape, and applying `20260914_000001_space_format`
 * on top of an already-populated table must backfill `format` to `markdown` on the existing row.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

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

describe('20260914_000001_space_format migration', () => {
  let tempDir: string;
  let databaseFile: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-space-format-'));
    databaseFile = path.join(tempDir, 'store.sqlite');
    db = createSqliteDb(databaseFile);
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('backfills format to markdown for a row created before the column existed', async () => {
    const migrator = await createMigrator(db);

    const toSpaceOnly = await migrator.migrateTo('20260913_000001_space');
    expect(toSpaceOnly.error).toBeUndefined();

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO space (tenant_id, created_by, id, name, purpose, status, body, revision, created_at, updated_at)
      VALUES ('default', 'user-a', 's-legacy', 'Legacy space', 'Pre-format row', 'active', '', 1, ${timestamp}, ${timestamp})
    `.execute(db);

    const toLatest = await migrator.migrateToLatest();
    expect(toLatest.error).toBeUndefined();

    const row = await db.selectFrom('space').selectAll().where('id', '=', 's-legacy').executeTakeFirstOrThrow();
    expect(row.format).toBe('markdown');
  });
});
