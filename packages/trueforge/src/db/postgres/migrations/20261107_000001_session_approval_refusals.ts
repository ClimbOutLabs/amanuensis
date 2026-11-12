import { sql, type Kysely } from 'kysely';

/** Durable browser refusals: a "no" to a browser open or click, kept for the rest of the chat. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .alterTable('session')
    .addColumn('approval_refusals', 'jsonb', column => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('session').dropColumn('approval_refusals').execute();
}
