import { sql, type Kysely } from 'kysely';

/**
 * The code version a skill's network grants are pinned to, beside the approved list.
 * Existing skills keep NULL: approvals saved before pinning stay in force unpinned and
 * gain a pin only when they are approved again; a check never writes one. Mirrors
 * db/postgres/migrations/20261114_000004_skill_network_approval_code_sha.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE skill ADD COLUMN network_approval_code_sha TEXT`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('skill').dropColumn('network_approval_code_sha').execute();
  });
}
