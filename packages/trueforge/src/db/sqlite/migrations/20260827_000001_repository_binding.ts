import { sql, type Kysely } from 'kysely';

/**
 * Historical repository-binding schema.
 *
 * Keep this migration registered permanently: deployed SQLite databases may
 * already record it as applied, even while the repository surface is absent
 * from a later application build.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE repository (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        name TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        default_branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, created_by, name)
      ) STRICT
    `.execute(trx);
    await trx.schema.alterTable('session').addColumn('repository_id', 'text').execute();
    await sql`
      CREATE INDEX session_repository_id_idx
        ON session (tenant_id, repository_id)
        WHERE repository_id IS NOT NULL
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP INDEX IF EXISTS session_repository_id_idx`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('repository_id').execute();
    await sql`DROP TABLE IF EXISTS repository`.execute(trx);
  });
}
