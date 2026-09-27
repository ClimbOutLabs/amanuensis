import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async transaction => {
    await sql`
      CREATE TABLE session_folder (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `.execute(transaction);
    await sql`
      CREATE INDEX session_folder_owner_name_idx
        ON session_folder (tenant_id, created_by, name, id)
    `.execute(transaction);
    await sql`
      ALTER TABLE session
        ADD COLUMN folder_id TEXT REFERENCES session_folder(id) ON DELETE SET NULL
    `.execute(transaction);
    await sql`
      CREATE INDEX session_folder_id_idx
        ON session (folder_id)
        WHERE folder_id IS NOT NULL
    `.execute(transaction);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async transaction => {
    await sql`DROP INDEX IF EXISTS session_folder_id_idx`.execute(transaction);
    await sql`ALTER TABLE session DROP COLUMN folder_id`.execute(transaction);
    await sql`DROP TABLE IF EXISTS session_folder`.execute(transaction);
  });
}
