import { sql, type Kysely } from 'kysely';

/**
 * The sites the person allowed one by one for a skill, and the sites they turned down, beside
 * the approved list. Existing skills get empty lists: no per-site decisions, exactly the
 * behaviour before network cards. Mirrors
 * db/postgres/migrations/20261112_000002_skill_network_host_decisions.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`ALTER TABLE skill ADD COLUMN network_allowed_hosts BLOB NOT NULL DEFAULT '[]'`.execute(trx);
    await sql`ALTER TABLE skill ADD COLUMN network_denied_hosts BLOB NOT NULL DEFAULT '[]'`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await trx.schema.alterTable('skill').dropColumn('network_allowed_hosts').execute();
    await trx.schema.alterTable('skill').dropColumn('network_denied_hosts').execute();
  });
}
