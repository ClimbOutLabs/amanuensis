import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The code version a skill's network grants are pinned to, beside the approved list.
 * Existing skills keep NULL: approvals saved before pinning stay in force unpinned and
 * gain a pin only when they are approved again; a check never writes one. Mirrors
 * db/sqlite/migrations/20261114_000004_skill_network_approval_code_sha.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`ALTER TABLE skill ADD COLUMN network_approval_code_sha text`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.alterTable('skill').dropColumn('network_approval_code_sha').execute();
  });
}
