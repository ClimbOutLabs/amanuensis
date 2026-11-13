import { sql, type Kysely } from 'kysely';

/**
 * Per-user allowance for package downloads in chats that are not working on a project: 1 lets the
 * sandbox download packages there through the mirrors, 0 asks on the first download. Defaults to
 * 0, off, including for a user with a saved row: a download allowance is only ever granted by the
 * person's own approval or switch.
 * Mirrors db/postgres/migrations/20261031_000001_sentinel_package_downloads_without_project.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so the Migrator runs this
  // outside any transaction; every schema-touching migration opens its own (see sqlite/AGENTS.md).
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE sentinel_user_settings
        ADD COLUMN package_downloads_without_project_allowed INTEGER NOT NULL DEFAULT 0 CHECK (package_downloads_without_project_allowed IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE sentinel_user_settings DROP COLUMN package_downloads_without_project_allowed`.execute(trx);
  });
}
