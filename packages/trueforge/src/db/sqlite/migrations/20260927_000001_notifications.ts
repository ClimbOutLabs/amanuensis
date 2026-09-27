import { sql, type Kysely } from 'kysely';

/**
 * In-app notifications for SQLite — mirrors
 * db/postgres/migrations/20260927_000001_notifications.ts.
 *
 * One `notification` row per reminder, briefing, or schedule completion/failure
 * notice. `schedule_id`/`schedule_run_id` are nullable provenance links without
 * a foreign key: schedule rows can be deleted while their notifications remain
 * readable history. The migration owns its own transaction because Kysely's
 * Migrator does not wrap SQLite migrations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE notification (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (length(kind) <= 32),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        schedule_id TEXT,
        schedule_run_id TEXT,
        created_by_subject BLOB NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      ) STRICT
    `.execute(trx);

    // Bell listing: unread first, then newest first, per tenant.
    await sql`
      CREATE INDEX notification_list_idx
        ON notification (tenant_id, read_at, created_at DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS notification`.execute(trx);
  });
}
