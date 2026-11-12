/**
 * `20261020_000002_mcp_tool_grant_server_host` binds each standing grant to its connector host. A grant
 * recorded before the column existed has no binding, so it must be removed rather than trusted on any URL.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

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

describe('20261020_000002_mcp_tool_grant_server_host migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-tool-grant-host-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes grants recorded before the host binding, so the next call asks again', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    await sql`
      INSERT INTO mcp_tool_grant (tenant_id, created_by, mcp_server_name, tool_name, created_at)
      VALUES ('t1', 'alice', 'notes', 'lookup_note', '2026-10-01T00:00:00.000Z')
    `.execute(db);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const remaining = await db.selectFrom('mcp_tool_grant').select('tool_name').execute();
    expect(remaining).toEqual([]);
  });
});
