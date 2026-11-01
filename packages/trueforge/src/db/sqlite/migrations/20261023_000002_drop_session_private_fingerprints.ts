import { sql, type Kysely } from 'kysely';

// Lookups are now judged by where their links came from, which is read from the chat itself, so nothing is kept here.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('session').dropColumn('private_fingerprints').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE session ADD COLUMN private_fingerprints BLOB`.execute(trx);
  });
}
