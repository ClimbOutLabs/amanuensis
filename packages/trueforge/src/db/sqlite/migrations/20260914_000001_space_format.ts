import { sql, type Kysely } from 'kysely';

/**
 * `format` on `space`: `markdown` (default) or `html`. `20260913_000001_space` already shipped
 * (build fe3d8653) without this column, so it is added here rather than edited in place.
 * Mirrors db/postgres/migrations/20260914_000001_space_format.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE space
        ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html'))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite cannot DROP COLUMN under STRICT without a table rebuild; irreversible.
  void db;
  return Promise.reject(new Error('20260914_000001_space_format is not reversible'));
}
