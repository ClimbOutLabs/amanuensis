import { sql, type Kysely } from 'kysely';

/**
 * The persona a schedule made in a chat runs as. Null runs the agent's own assistant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE schedule ADD COLUMN persona_id TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE schedule DROP COLUMN persona_id`.execute(trx);
  });
}
