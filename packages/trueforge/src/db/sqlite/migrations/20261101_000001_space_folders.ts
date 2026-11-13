import { sql, type Kysely } from 'kysely';

/**
 * Folders for spaces. Placement lives in its own table, beside the space row, so moving a space
 * never touches its revision, its history, or the owner's space revision.
 * Mirrors db/postgres/migrations/20261101_000001_space_folders.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE space_folder (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX space_folder_owner_name_idx
        ON space_folder (tenant_id, created_by, name, id)
    `.execute(trx);
    await sql`
      CREATE TABLE space_folder_assignment (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        space_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, space_id),
        FOREIGN KEY (tenant_id, created_by, space_id)
          REFERENCES space (tenant_id, created_by, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, created_by, folder_id)
          REFERENCES space_folder (tenant_id, created_by, id) ON DELETE CASCADE
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX space_folder_assignment_folder_idx
        ON space_folder_assignment (tenant_id, created_by, folder_id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE space_folder_assignment`.execute(trx);
    await sql`DROP TABLE space_folder`.execute(trx);
  });
}
