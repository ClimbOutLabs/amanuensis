import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/** Completes the historical repository binding with revisioned verification metadata. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .alterTable('repository')
      .addColumn('revision', 'integer', column => column.notNull().defaultTo(0))
      .execute();
    await sql`ALTER TABLE repository ADD CONSTRAINT repository_revision_check CHECK (revision >= 0)`.execute(trx);
    await trx.schema.alterTable('session').addColumn('workspace_cwd', 'text').execute();
    await sql`
    ALTER TABLE session
      ADD CONSTRAINT session_workspace_cwd_check
      CHECK (workspace_cwd IS NULL OR length(trim(workspace_cwd)) > 0)
  `.execute(trx);

    await trx.schema
      .createTable('repository_verify_command')
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('command_id', 'text', column => column.notNull())
      .addColumn('purpose', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('timeout_ms', 'integer', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addColumn('updated_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('repository_verify_command_pkey', ['repository_id', 'command_id'])
      .addForeignKeyConstraint(
        'repository_verify_command_repository_fkey',
        ['repository_id'],
        'repository',
        ['id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_purpose_check
      CHECK (purpose IN ('build', 'test', 'verify'))
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_text_check
      CHECK (length(trim(command_id)) > 0 AND length(command) > 0)
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command
      ADD CONSTRAINT repository_verify_command_timeout_check
      CHECK (timeout_ms BETWEEN 1 AND 3600000)
  `.execute(trx);
    await trx.schema
      .createIndex('repository_verify_command_repository_idx')
      .on('repository_verify_command')
      .columns(['repository_id', 'purpose', 'command_id'])
      .execute();

    await trx.schema
      .createTable('repository_verify_command_proposal')
      .addColumn('id', 'text', column => column.notNull())
      .addColumn('repository_id', 'text', column => column.notNull())
      .addColumn('purpose', 'text', column => column.notNull())
      .addColumn('command', 'text', column => column.notNull())
      .addColumn('source_kind', 'text', column => column.notNull())
      .addColumn('source_path', 'text', column => column.notNull())
      .addColumn('source_fingerprint', 'text', column => column.notNull())
      .addColumn('created_at', 'timestamptz', column => column.notNull())
      .addPrimaryKeyConstraint('repository_verify_command_proposal_pkey', ['repository_id', 'id'])
      .addForeignKeyConstraint(
        'repository_verify_command_proposal_repository_fkey',
        ['repository_id'],
        'repository',
        ['id'],
        constraint => constraint.onDelete('cascade'),
      )
      .execute();
    await sql`
    ALTER TABLE repository_verify_command_proposal
      ADD CONSTRAINT repository_verify_command_proposal_purpose_check
      CHECK (purpose IN ('build', 'test', 'verify'))
  `.execute(trx);
    await sql`
    ALTER TABLE repository_verify_command_proposal
      ADD CONSTRAINT repository_verify_command_proposal_text_check
      CHECK (
        length(command) > 0
        AND source_kind IN ('agents_md', 'package_json')
        AND length(trim(source_path)) > 0
        AND length(trim(source_fingerprint)) > 0
      )
  `.execute(trx);
    await trx.schema
      .createIndex('repository_verify_command_proposal_repository_idx')
      .on('repository_verify_command_proposal')
      .columns(['repository_id', 'created_at', 'id'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('repository_verify_command_proposal').ifExists().cascade().execute();
    await trx.schema.dropTable('repository_verify_command').ifExists().cascade().execute();
    await sql`ALTER TABLE session DROP CONSTRAINT IF EXISTS session_workspace_cwd_check`.execute(trx);
    await trx.schema.alterTable('session').dropColumn('workspace_cwd').execute();
    await sql`ALTER TABLE repository DROP CONSTRAINT IF EXISTS repository_revision_check`.execute(trx);
    await trx.schema.alterTable('repository').dropColumn('revision').execute();
  });
}
