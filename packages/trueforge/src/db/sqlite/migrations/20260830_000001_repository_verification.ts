import { sql, type Kysely } from 'kysely';

/**
 * Completes the historical repository binding with revisioned verification
 * metadata. Suggestions are deliberately kept in a separate table: only rows
 * in repository_verify_command are eligible for a future executor.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      ALTER TABLE repository
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    `.execute(trx);
    await sql`
      ALTER TABLE session
        ADD COLUMN workspace_cwd TEXT CHECK (workspace_cwd IS NULL OR length(trim(workspace_cwd)) > 0)
    `.execute(trx);

    await sql`
      CREATE TABLE repository_verify_command (
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL CHECK (length(trim(command_id)) > 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('build', 'test', 'verify')),
        command TEXT NOT NULL CHECK (length(command) > 0),
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 3600000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, command_id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX repository_verify_command_repository_idx
        ON repository_verify_command (repository_id, purpose, command_id)
    `.execute(trx);

    await sql`
      CREATE TABLE repository_verify_command_proposal (
        id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('build', 'test', 'verify')),
        command TEXT NOT NULL CHECK (length(command) > 0),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('agents_md', 'package_json')),
        source_path TEXT NOT NULL CHECK (length(trim(source_path)) > 0),
        source_fingerprint TEXT NOT NULL CHECK (length(trim(source_fingerprint)) > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX repository_verify_command_proposal_repository_idx
        ON repository_verify_command_proposal (repository_id, created_at, id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE IF EXISTS repository_verify_command_proposal`.execute(trx);
    await sql`DROP TABLE IF EXISTS repository_verify_command`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('workspace_cwd').execute();
    await trx.schema.alterTable('repository').dropColumn('revision').execute();
  });
}
