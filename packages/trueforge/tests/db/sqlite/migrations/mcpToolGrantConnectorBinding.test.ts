/**
 * `20261112_000002_mcp_tool_grant_connector_binding` binds each standing grant to its connector's setup instead
 * of its host. A grant recorded for a host can never match a setup, so it is removed and the next call asks again.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteMcpToolGrantStore } from '../../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261111_000001_noticing';
const THIS_MIGRATION = '20261112_000002_mcp_tool_grant_connector_binding';

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

describe('20261112_000002_mcp_tool_grant_connector_binding migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-tool-grant-binding-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes grants bound to a host, so the next call asks again', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    await sql`
      INSERT INTO mcp_tool_grant (tenant_id, created_by, mcp_server_name, tool_name, mcp_server_host, created_at)
      VALUES ('t1', 'alice', 'notes', 'lookup_note', 'notes.example.com', '2026-10-01T00:00:00.000Z')
    `.execute(db);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const remaining = await db.selectFrom('mcp_tool_grant').select('tool_name').execute();
    expect(remaining).toEqual([]);
  });

  it('keeps a grant recorded after migrating bound to its setup', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const store = new SqliteMcpToolGrantStore(db);
    const key = {
      tenant_id: 't1',
      created_by: 'alice',
      mcp_server_name: 'notes',
      tool_name: 'lookup_note',
      connector_binding: 'setup-of-notes',
    };
    await store.recordToolGrant(key);

    expect(await store.hasToolGrant(key)).toBe(true);
    expect(await store.hasToolGrant({ ...key, connector_binding: 'setup-of-elsewhere' })).toBe(false);
  });

  it('migrates down to the host column and back with no grant surviving either way', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    await new SqliteMcpToolGrantStore(db).recordToolGrant({
      tenant_id: 't1',
      created_by: 'alice',
      mcp_server_name: 'notes',
      tool_name: 'lookup_note',
      connector_binding: 'setup-of-notes',
    });
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    expect(await db.selectFrom('mcp_tool_grant').select('tool_name').execute()).toEqual([]);
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();
  });
});
