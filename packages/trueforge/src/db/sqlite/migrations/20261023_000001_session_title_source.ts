import { sql, type Kysely } from 'kysely';

// Existing chats keep a NULL source: they are never retitled automatically.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE session ADD COLUMN title_source TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('session').dropColumn('title_source').execute();
  });
}
