import { sql, type Kysely } from 'kysely';

/**
 * Command proposals can now also come from pyproject.toml and a Makefile, so
 * the stored source kind check learns both new kinds.
 */
async function setSourceKinds(db: Kysely<unknown>, sourceKinds: string): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    ALTER TABLE repository_verify_command_proposal
      DROP CONSTRAINT repository_verify_command_proposal_text_check
  `.execute(db);
  await sql`
    ALTER TABLE repository_verify_command_proposal
      ADD CONSTRAINT repository_verify_command_proposal_text_check
      CHECK (
        length(command) > 0
        AND source_kind IN (${sql.raw(sourceKinds)})
        AND length(trim(source_path)) > 0
        AND length(trim(source_fingerprint)) > 0
      )
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setSourceKinds(db, `'agents_md', 'makefile', 'package_json', 'pyproject_toml'`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await setSourceKinds(db, `'agents_md', 'package_json'`);
}
