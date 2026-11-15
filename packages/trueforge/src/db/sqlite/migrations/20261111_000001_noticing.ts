import { sql, type Kysely } from 'kysely';

/**
 * What the assistant notices for a person: their Reach me settings, the events the watchers found (one row per stable
 * event id, so nothing is raised twice, claimed by one pass at a time until delivered), where each watcher reads from
 * next (and how its passes are doing: since when they have failed and why, and the one message a pass keeps failing on),
 * and the per-person lease that keeps two passes from deciding how loudly to reach someone at once. `kind` and
 * `status` are plain text with no check, so a later kind needs no migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE reach_settings (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE noticing_event (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        event_json TEXT NOT NULL,
        due_at TEXT,
        verdict_json TEXT,
        delivery_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claim_id TEXT,
        claimed_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE UNIQUE INDEX noticing_event_owner_event_uq ON noticing_event (tenant_id, created_by, event_id)
    `.execute(trx);
    await sql`
      CREATE INDEX noticing_event_tracking_idx ON noticing_event (tenant_id, created_by, status, due_at)
    `.execute(trx);
    await sql`
      CREATE TABLE noticing_checkpoint (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        watcher TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        failing_since TEXT,
        failure_kind TEXT,
        stuck_message_id TEXT,
        stuck_passes INTEGER NOT NULL DEFAULT 0,
        stuck_since TEXT,
        imap_cursor TEXT,
        source TEXT,
        PRIMARY KEY (tenant_id, created_by, watcher)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE reach_lease (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        holder TEXT NOT NULL,
        held_until TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE reach_lease`.execute(trx);
    await sql`DROP TABLE noticing_checkpoint`.execute(trx);
    await sql`DROP TABLE noticing_event`.execute(trx);
    await sql`DROP TABLE reach_settings`.execute(trx);
  });
}
