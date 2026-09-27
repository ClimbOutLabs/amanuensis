import { sql, type Kysely } from 'kysely';

/**
 * Persisted sandbox-artifact bytes, copied from the sandbox once a turn finishes so a download
 * outlives the sandbox that produced it (the provider auto-stops and later deletes it).
 * `artifact_blob` is content-addressed and deduplicated by digest within a tenant; `turn_artifact`
 * is the per-turn, per-path index the download route looks up.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE artifact_blob (
        tenant_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        mime TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, digest)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE turn_artifact (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('stored', 'skipped_size', 'skipped_missing')),
        digest TEXT,
        size INTEGER,
        mime TEXT,
        skip_reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, turn_id, path)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX turn_artifact_session_idx
      ON turn_artifact (tenant_id, session_id, turn_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE turn_artifact`.execute(trx);
    await sql`DROP TABLE artifact_blob`.execute(trx);
  });
}
