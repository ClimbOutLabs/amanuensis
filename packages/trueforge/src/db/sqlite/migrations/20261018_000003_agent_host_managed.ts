import { sql, type Kysely } from 'kysely';

/**
 * Marks the agents the host makes so a chat's schedules can run. People never pick them, so agent lists leave them out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE agent
        ADD COLUMN host_managed INTEGER NOT NULL DEFAULT 0 CHECK (host_managed IN (0, 1))
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE agent DROP COLUMN host_managed`.execute(trx);
  });
}
