import { sql, type Kysely } from 'kysely';

/**
 * The persona a schedule made in a chat runs as. Null runs the agent's own assistant.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('schedule').addColumn('persona_id', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('schedule').dropColumn('persona_id').execute();
}
