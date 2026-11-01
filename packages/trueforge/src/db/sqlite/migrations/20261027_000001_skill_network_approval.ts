import { sql, type Kysely } from 'kysely';

/**
 * The person's approved site list for a skill's network access, beside the manifest.
 * Existing skills keep NULL: no approval, no network, exactly today's behaviour.
 * Mirrors db/postgres/migrations/20261027_000001_skill_network_approval.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE skill ADD COLUMN network_approval BLOB`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('skill').dropColumn('network_approval').execute();
  });
}
