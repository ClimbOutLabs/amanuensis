import { sql, type Kysely } from 'kysely';

/**
 * Restores `session.task_checklist` for databases upgrading from the
 * pre-sync schema chain (fork tip before the 2026-09-13 upstream sync,
 * commit c764d444). Same cause as `20260901_000099_session_workspace_cwd`:
 * the sync's `20260827_000001_session_metrics` rebuilds `session` without
 * `task_checklist` in its column list (that column did not exist upstream
 * at the time that migration was authored), silently dropping it when
 * `allowUnorderedMigrations` runs that migration out of filename order on
 * a database that already applied the fork's own
 * `20260831_000001_task_checklist`.
 *
 * On a fresh install, `20260831_000001_task_checklist` already added the
 * column by the time this migration runs, so the guard below is a no-op
 * there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{ name: string }>`PRAGMA table_info(session)`.execute(db);
  const hasTaskChecklist = columns.rows.some(column => column.name === 'task_checklist');

  if (!hasTaskChecklist) {
    await sql`ALTER TABLE session ADD COLUMN task_checklist BLOB`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{ name: string }>`PRAGMA table_info(session)`.execute(db);
  const hasTaskChecklist = columns.rows.some(column => column.name === 'task_checklist');

  if (hasTaskChecklist) {
    await db.schema.alterTable('session').dropColumn('task_checklist').execute();
  }
}
