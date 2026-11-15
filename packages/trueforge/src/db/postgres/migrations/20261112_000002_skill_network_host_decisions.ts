import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The sites the person allowed one by one for a skill, and the sites they turned down, beside
 * the approved list. Existing skills get empty lists: no per-site decisions, exactly the
 * behaviour before network cards. Mirrors
 * db/sqlite/migrations/20261112_000002_skill_network_host_decisions.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`ALTER TABLE skill ADD COLUMN network_allowed_hosts jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(trx);
    await sql`ALTER TABLE skill ADD COLUMN network_denied_hosts jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('skill').dropColumn('network_allowed_hosts').execute();
    await trx.schema.alterTable('skill').dropColumn('network_denied_hosts').execute();
  });
}
