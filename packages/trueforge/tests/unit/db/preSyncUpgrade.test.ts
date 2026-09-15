import { sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { preSyncSqliteMigrations } from '../../fixtures/pre-sync-schema-c764d444/preSyncSqliteMigrations';

/**
 * Builds a database on the migration chain from commit c764d444 (main's tip
 * immediately before the upstream sync, PR #174 / 96e0fb1f) and confirms the
 * current migrator can still bring it to latest.
 *
 * Regression coverage for: the sync added `20260827_000001_session_metrics`,
 * which rebuilds `session` with a column list current only as of upstream's
 * 2026-08-27. `allowUnorderedMigrations` runs it on this chain *after* the
 * fork's own `20260830_000001_repository_verification` (adds
 * `workspace_cwd`) and `20260831_000001_task_checklist` had already run, so
 * the rebuild silently dropped both columns, and the later
 * `20260902_000001_session_metadata` rebuild (which assumes they exist)
 * failed with "no such column: workspace_cwd".
 */

class StaticMigrationProvider implements MigrationProvider {
  readonly #migrations: Record<string, Migration>;

  constructor(migrations: Record<string, Migration>) {
    this.#migrations = migrations;
  }

  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(this.#migrations);
  }
}

describe('pre-sync (c764d444) SQLite chain upgrades to latest', () => {
  it('runs every pending migration and rebuilds session with every current column', async () => {
    const db = createSqliteDb(':memory:');
    try {
      const preSyncMigrator = new Migrator({
        db,
        allowUnorderedMigrations: true,
        provider: new StaticMigrationProvider(preSyncSqliteMigrations),
      });
      const preSyncResult = await preSyncMigrator.migrateToLatest();
      expect(preSyncResult.error).toBeUndefined();
      expect(preSyncResult.results?.some(r => r.status !== 'Success')).toBe(false);

      await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();

      const columns = await sql<{ name: string }>`PRAGMA table_info(session)`.execute(db);
      const columnNames = columns.rows.map(row => row.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'tenant_id',
          'session_id',
          'created_by_subject',
          'source',
          'agent_id',
          'repository_id',
          'workspace_cwd',
          'agent_name',
          'agent_spec',
          'title',
          'folder_id',
          'last_turn_id',
          'approval_grants',
          'task_checklist',
          'external_id',
          'custom',
          'metadata',
          'metrics',
          'last_activity_timestamp_ms',
          'created_at',
          'updated_at',
        ]),
      );
    } finally {
      await db.destroy();
    }
  });
});
