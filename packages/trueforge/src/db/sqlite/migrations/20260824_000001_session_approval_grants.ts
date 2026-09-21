import { sql, type Kysely } from 'kysely';

/** Durable exact-tool grants created by "Allow for this chat". */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE session
        ADD COLUMN approval_grants TEXT NOT NULL DEFAULT '[]'
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  return Promise.reject(new Error('20260824_000001_session_approval_grants is not reversible'));
}
