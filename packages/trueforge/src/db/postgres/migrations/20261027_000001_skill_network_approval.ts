import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The person's approved site list for a skill's network access, beside the manifest.
 * Existing skills keep NULL: no approval, no network, exactly today's behaviour.
 * Mirrors db/sqlite/migrations/20261027_000001_skill_network_approval.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('skill').addColumn('network_approval', 'jsonb').execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('skill').dropColumn('network_approval').execute();
  });
}
