/**
 * `20261020_000001_sentinel_maps_without_asking` adds the per-user maps switch. A user saved before
 * it existed must come out with maps asking, the same default as a user with no row, and rolling it
 * back must keep the rows.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261018_000003_agent_host_managed';
const THIS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

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

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`PRAGMA table_info(sentinel_user_settings)`.execute(db);
  return rows.map(row => row.name);
}

describe('20261020_000001_sentinel_maps_without_asking migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-maps-setting-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('leaves a user saved before the column existed with maps asking', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    expect(await columnNames(db)).not.toContain('maps_without_asking');

    await sql`
      INSERT INTO sentinel_user_settings (tenant_id, created_by, offline_mode, tier2_auto_allow, created_at, updated_at)
      VALUES ('t1', 'alice', 1, jsonb('[]'), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `.execute(db);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const row = await db
      .selectFrom('sentinel_user_settings')
      .select('maps_without_asking')
      .where('created_by', '=', 'alice')
      .executeTakeFirst();
    expect(row?.maps_without_asking).toBe(0);
  });

  it('only accepts 0 or 1 for the setting', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    await expect(
      sql`
        INSERT INTO sentinel_user_settings
          (tenant_id, created_by, offline_mode, tier2_auto_allow, maps_without_asking, created_at, updated_at)
        VALUES ('t1', 'bad', 0, jsonb('[]'), 2, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `.execute(db),
    ).rejects.toThrow();
  });

  it('rolls back by dropping the column and keeping the users', async () => {
    const migrator = await createMigrator(db);
    // Stop at this migration so rolling back one step undoes it, whatever lands after it.
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();
    await sql`
      INSERT INTO sentinel_user_settings
        (tenant_id, created_by, offline_mode, tier2_auto_allow, maps_without_asking, created_at, updated_at)
      VALUES ('t1', 'kept', 0, jsonb('[]'), 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `.execute(db);

    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    expect(await columnNames(db)).not.toContain('maps_without_asking');
    const kept = await sql<{ created_by: string }>`SELECT created_by FROM sentinel_user_settings`.execute(db);
    expect(kept.rows).toEqual([{ created_by: 'kept' }]);
  });
});
