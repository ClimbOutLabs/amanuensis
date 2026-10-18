import { sql, type Kysely } from 'kysely';

/**
 * Marks the agents the host makes so a chat's schedules can run. People never pick them, so agent lists leave them out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('agent')
    .addColumn('host_managed', 'boolean', col => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('agent').dropColumn('host_managed').execute();
}
