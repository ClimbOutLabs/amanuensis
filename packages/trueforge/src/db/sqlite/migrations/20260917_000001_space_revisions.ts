import { sql, type Kysely } from 'kysely';

/**
 * Revision history for spaces: bounded snapshots of superseded revisions, so a bad update can
 * be read back and restored. The store keeps the most recent `SPACE_REVISION_HISTORY_LIMIT`
 * snapshots per space and prunes older ones on each write.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE space_revision (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        space_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        body TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, space_id, revision)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX space_revision_lookup_idx
      ON space_revision (tenant_id, created_by, space_id, revision DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE space_revision`.execute(trx);
  });
}
