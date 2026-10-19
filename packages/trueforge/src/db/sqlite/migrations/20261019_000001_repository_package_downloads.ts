import { sql, type Kysely } from 'kysely';

/**
 * Whether the person has allowed this repo's packages to be downloaded through the mirrors.
 * Off until allowed, and read again on every sandbox command, so taking it back stops downloads.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE repository
        ADD COLUMN package_downloads_allowed INTEGER NOT NULL DEFAULT 0 CHECK (package_downloads_allowed IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE repository DROP COLUMN package_downloads_allowed`.execute(trx);
  });
}
