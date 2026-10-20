import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';
import { PREVIOUS_MIGRATION, runSearchProviderDefaultMigrationSuite } from '../../searchProviderDefaultMigrationSuite';

runSearchProviderDefaultMigrationSuite({
  describeFn: describe,
  setup: async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-search-default-'));
    const db: Kysely<Database> = createSqliteDb(path.join(tempDir, 'store.sqlite'));
    const migrator = new Migrator({
      db,
      allowUnorderedMigrations: true,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(import.meta.dirname, '..', '..', '..', '..', 'src', 'db', 'sqlite', 'migrations'),
      }),
    });
    const before = await migrator.migrateTo(PREVIOUS_MIGRATION);
    expect(before.error).toBeUndefined();
    return {
      async insert(row) {
        const timestamp = new Date().toISOString();
        await sql`
          INSERT INTO mcp_server (id, tenant_id, name, manifest, created_at, updated_at)
          VALUES (${row.id}, ${row.tenant_id}, ${row.name}, jsonb(${JSON.stringify(row.manifest)}), ${timestamp}, ${timestamp})
        `.execute(db);
      },
      async migrate() {
        const toLatest = await migrator.migrateToLatest();
        expect(toLatest.error).toBeUndefined();
      },
      async manifestOf(id) {
        const { rows } = await sql<{
          manifest: Record<string, unknown>;
        }>`SELECT json(manifest) AS manifest FROM mcp_server WHERE id = ${id}`.execute(db);
        return rows[0]?.manifest ?? {};
      },
      async teardown() {
        await db.destroy();
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  },
});
