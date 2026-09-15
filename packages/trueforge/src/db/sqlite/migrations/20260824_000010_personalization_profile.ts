import { sql, type Kysely } from 'kysely';

/** Local per-user assistant/user profile. No session or conversation data is copied here. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE personalization_profile (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        assistant_name TEXT,
        assistant_identity TEXT,
        voice_guidance TEXT,
        user_profile TEXT,
        pinned_preferences BLOB NOT NULL,
        revision INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS personalization_profile`.execute(trx);
  });
}
