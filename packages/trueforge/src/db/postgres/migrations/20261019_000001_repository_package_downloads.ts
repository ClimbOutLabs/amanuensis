import { sql, type Kysely } from 'kysely';

/**
 * Whether the person has allowed this repo's packages to be downloaded through the mirrors.
 * Off until allowed, and read again on every sandbox command, so taking it back stops downloads.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('repository')
    .addColumn('package_downloads_allowed', 'boolean', col => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('repository').dropColumn('package_downloads_allowed').execute();
}
