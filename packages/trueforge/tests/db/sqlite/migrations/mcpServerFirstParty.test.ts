/**
 * `20261010_000007_mcp_server_first_party` adds the server-owned trust marker. Every connector
 * stored before it existed must come out untrusted, and rolling it back must keep the rows.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261010_000006_mcp_tool_grant';
const THIS_MIGRATION = '20261010_000007_mcp_server_first_party';

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
  const { rows } = await sql<{ name: string }>`PRAGMA table_info(mcp_server)`.execute(db);
  return rows.map(row => row.name);
}

describe('20261010_000007_mcp_server_first_party migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-first-party-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('leaves a connector stored before the column existed untrusted', async () => {
    const migrator = await createMigrator(db);
    const beforeColumn = await migrator.migrateTo(PREVIOUS_MIGRATION);
    expect(beforeColumn.error).toBeUndefined();
    expect(await columnNames(db)).not.toContain('first_party');

    const manifest = {
      type: 'remote',
      name: 'legacy',
      url: 'https://hindsight.example.com/mcp/aman',
      description: 'Stored before the marker existed.',
      memory_provider: true,
    };
    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO mcp_server (id, tenant_id, name, manifest, created_at, updated_at)
      VALUES ('s-legacy', 'default', 'legacy', jsonb(${JSON.stringify(manifest)}), ${timestamp}, ${timestamp})
    `.execute(db);

    const toLatest = await migrator.migrateToLatest();
    expect(toLatest.error).toBeUndefined();

    const row = await db.selectFrom('mcp_server').select('first_party').where('id', '=', 's-legacy').executeTakeFirst();
    expect(row?.first_party).toBe(0);
  });

  it('only accepts 0 or 1 for the marker', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const timestamp = new Date().toISOString();
    await expect(
      sql`
        INSERT INTO mcp_server (id, tenant_id, name, manifest, first_party, created_at, updated_at)
        VALUES ('s-bad', 'default', 'bad', jsonb('{}'), 2, ${timestamp}, ${timestamp})
      `.execute(db),
    ).rejects.toThrow();
  });

  it('rolls back by dropping the column and keeping the connectors', async () => {
    const migrator = await createMigrator(db);
    // Stop at this migration so rolling back undoes only it, whatever lands after it.
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();

    const timestamp = new Date().toISOString();
    await sql`
      INSERT INTO mcp_server (id, tenant_id, name, manifest, first_party, created_at, updated_at)
      VALUES ('s-kept', 'default', 'kept', jsonb('{}'), 1, ${timestamp}, ${timestamp})
    `.execute(db);

    const rolledBack = await migrator.migrateTo(PREVIOUS_MIGRATION);
    expect(rolledBack.error).toBeUndefined();
    expect(await columnNames(db)).not.toContain('first_party');
    const kept = await sql<{ name: string }>`SELECT name FROM mcp_server WHERE id = 's-kept'`.execute(db);
    expect(kept.rows).toEqual([{ name: 'kept' }]);
  });
});
