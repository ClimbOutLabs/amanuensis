import { sql, type Kysely } from 'kysely';

/** Durable browser refusals: a "no" to a browser open or click, kept for the rest of the chat. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN approval_refusals BLOB NOT NULL DEFAULT X'0B'
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        DROP COLUMN approval_refusals
    `.execute(trx);
  });
}
