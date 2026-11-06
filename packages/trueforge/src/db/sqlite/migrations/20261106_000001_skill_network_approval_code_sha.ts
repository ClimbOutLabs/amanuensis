import { sql, type Kysely } from 'kysely';

/**
 * The code version a skill's network approval is pinned to, beside the approved list.
 * Existing skills keep NULL: approvals saved before pinning stay in force and gain a pin
 * the next time they are checked. Mirrors
 * db/postgres/migrations/20261106_000001_skill_network_approval_code_sha.ts.
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
