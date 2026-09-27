import { sql, type Kysely } from 'kysely';

/**
 * User-configured personas and the per-session log of which one answered.
 *
 * `session_persona` is append-only: its highest-`seq` row is the chat's active
 * persona, and each row carrying a `turn_id` is that turn's provenance. It is
 * not a foreign key onto `persona` — deleting a persona must not erase the
 * record of turns it already answered.
 *
 * Ordering is `seq`, not a timestamp or a ulid: two decisions can land in the
 * same millisecond, and "which persona is active" must never depend on which
 * of two same-instant rows sorted first.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE persona (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aliases BLOB NOT NULL,
        instructions TEXT NOT NULL,
        model_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX persona_owner_idx ON persona (tenant_id, created_by, display_name)`.execute(trx);
    await sql`
      CREATE TABLE session_persona (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        turn_id TEXT,
        persona_id TEXT,
        persona_name TEXT,
        model_name TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, seq)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS session_persona`.execute(trx);
    await sql`DROP TABLE IF EXISTS persona`.execute(trx);
  });
}
