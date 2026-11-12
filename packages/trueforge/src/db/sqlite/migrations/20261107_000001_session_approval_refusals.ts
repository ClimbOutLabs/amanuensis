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
  void db;
  return Promise.reject(new Error('20261107_000001_session_approval_refusals is not reversible'));
}
