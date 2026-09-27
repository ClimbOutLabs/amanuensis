import { sql, type Kysely } from 'kysely';

/**
 * In-app notifications — mirrors
 * db/sqlite/migrations/20260927_000001_notifications.ts.
 *
 * One `notification` row per reminder, briefing, or schedule completion/failure
 * notice. `schedule_id`/`schedule_run_id` are nullable provenance links without
 * a foreign key: schedule rows can be deleted while their notifications remain
 * readable history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`
      CREATE TABLE notification (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (length(kind) <= 32),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        schedule_id TEXT,
        schedule_run_id TEXT,
        created_by_subject JSONB NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
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
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`DROP TABLE IF EXISTS notification`.execute(trx);
  });
}
