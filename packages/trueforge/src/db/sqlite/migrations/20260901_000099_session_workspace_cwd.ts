import { sql, type Kysely } from 'kysely';

/**
 * Restores `session.workspace_cwd` for databases upgrading from the
 * pre-sync schema chain (fork tip before the 2026-09-13 upstream sync,
 * commit c764d444).
 *
 * That chain's own `20260830_000001_repository_verification` migration had
 * already added the column with `ALTER TABLE session ADD COLUMN
 * workspace_cwd ...`. `allowUnorderedMigrations` then runs the sync's
 * `20260827_000001_session_metrics` out of filename order on such a
 * database: it rebuilds `session` into `session_new` without
 * `workspace_cwd` in the column list, silently dropping it. The later
 * `20260902_000001_session_metadata` rebuild assumes the column exists and
 * fails with "no such column: workspace_cwd".
 *
 * On a fresh install, `20260830_000001_repository_verification` already
 * added the column by the time this migration runs, so the guard below is
 * a no-op there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{ name: string }>`PRAGMA table_info(session)`.execute(db);
  const hasWorkspaceCwd = columns.rows.some(column => column.name === 'workspace_cwd');

  if (!hasWorkspaceCwd) {
    await sql`
      ALTER TABLE session
        ADD COLUMN workspace_cwd TEXT CHECK (workspace_cwd IS NULL OR length(trim(workspace_cwd)) > 0)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{ name: string }>`PRAGMA table_info(session)`.execute(db);
  const hasWorkspaceCwd = columns.rows.some(column => column.name === 'workspace_cwd');

  if (hasWorkspaceCwd) {
    await db.schema.alterTable('session').dropColumn('workspace_cwd').execute();
  }
}
