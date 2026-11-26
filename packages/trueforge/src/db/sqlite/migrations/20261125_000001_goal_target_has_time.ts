import { sql, type Kysely } from 'kysely';

/**
 * Whether a goal's target carries a time of day the person chose. Defaults to
 * 0, so every goal stored before this column reads as a date alone, which is
 * how the screens already show those goals. Mirrors
 * db/postgres/migrations/20261125_000001_goal_target_has_time.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE goal
        ADD COLUMN target_has_time INTEGER NOT NULL DEFAULT 0 CHECK (target_has_time IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT, so the table is rebuilt without the column.
  // goal is a referenced parent, so foreign keys go off outside the transaction while the
  // rebuilt table takes its place (see sqlite/AGENTS.md).
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`
        CREATE TABLE goal_old (
          goal_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          pinned_agent_id TEXT,
          pinned_agent_version TEXT,
          pinned_agent_snapshot TEXT,
          title TEXT NOT NULL,
          outcome TEXT NOT NULL,
          success_criteria TEXT NOT NULL,
          target_at TEXT,
          timezone TEXT,
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'completed', 'ended')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          linked_space_id TEXT,
          execution_policy TEXT NOT NULL,
          notification_policy TEXT NOT NULL,
          next_check_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (goal_id)
        ) STRICT
      `.execute(trx);
      await sql`
        INSERT INTO goal_old (
          goal_id,
          tenant_id,
          created_by,
          persona_id,
          pinned_agent_id,
          pinned_agent_version,
          pinned_agent_snapshot,
          title,
          outcome,
          success_criteria,
          target_at,
          timezone,
          lifecycle,
          revision,
          linked_space_id,
          execution_policy,
          notification_policy,
          next_check_at,
          created_at,
          updated_at
        )
        SELECT
          goal_id,
          tenant_id,
          created_by,
          persona_id,
          pinned_agent_id,
          pinned_agent_version,
          pinned_agent_snapshot,
          title,
          outcome,
          success_criteria,
          target_at,
          timezone,
          lifecycle,
          revision,
          linked_space_id,
          execution_policy,
          notification_policy,
          next_check_at,
          created_at,
          updated_at
        FROM goal
      `.execute(trx);
      await sql`DROP TABLE goal`.execute(trx);
      await sql`ALTER TABLE goal_old RENAME TO goal`.execute(trx);
      await sql`CREATE INDEX goal_owner_idx ON goal (tenant_id, created_by, lifecycle)`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}
