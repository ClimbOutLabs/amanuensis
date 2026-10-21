import { sql, type Kysely } from 'kysely';

/**
 * Command proposals can now also come from pyproject.toml and a Makefile, so
 * the stored source kind check learns both new kinds. SQLite keeps the check
 * inside the table definition, so the table is rebuilt in place.
 */
async function rebuild(db: Kysely<unknown>, sourceKinds: string): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE repository_verify_command_proposal_next (
        id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('build', 'test', 'verify')),
        command TEXT NOT NULL CHECK (length(command) > 0),
        source_kind TEXT NOT NULL CHECK (source_kind IN (${sql.raw(sourceKinds)})),
        source_path TEXT NOT NULL CHECK (length(trim(source_path)) > 0),
        source_fingerprint TEXT NOT NULL CHECK (length(trim(source_fingerprint)) > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, id)
      ) STRICT
    `.execute(trx);
    await sql`
      INSERT INTO repository_verify_command_proposal_next
        (id, repository_id, purpose, command, source_kind, source_path, source_fingerprint, created_at)
      SELECT id, repository_id, purpose, command, source_kind, source_path, source_fingerprint, created_at
        FROM repository_verify_command_proposal
    `.execute(trx);
    await sql`DROP TABLE repository_verify_command_proposal`.execute(trx);
    await sql`
      ALTER TABLE repository_verify_command_proposal_next
        RENAME TO repository_verify_command_proposal
    `.execute(trx);
    await sql`
      CREATE INDEX repository_verify_command_proposal_repository_idx
        ON repository_verify_command_proposal (repository_id, created_at, id)
    `.execute(trx);
  });
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await rebuild(db, `'agents_md', 'makefile', 'package_json', 'pyproject_toml'`);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await rebuild(db, `'agents_md', 'package_json'`);
}
