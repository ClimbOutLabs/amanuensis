import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * A reading voice per persona: replies from that persona are read aloud in it. NULL (every
 * existing persona) keeps the voice the person picked for all replies.
 * Mirrors db/sqlite/migrations/20261106_000001_persona_voice.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('persona').addColumn('voice', 'text').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('persona').dropColumn('voice').execute();
  });
}
