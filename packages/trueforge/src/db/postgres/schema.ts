import { type Kysely, sql } from 'kysely';

import type { Database } from './types';

export const TRUEFORGE_SCHEMA = 'trueforge';

/**
 * Every table the `trueforge` schema owns: the migrator's own bookkeeping
 * tables plus every table any Postgres migration creates. `ensureTrueforgeSchema`
 * moves each of these out of `public` and into `trueforge`.
 *
 * Kept complete by `tests/unit/db/postgres/schema.test.ts`, which scans every
 * file under `./migrations` for a created table name and fails if one is
 * missing here.
 */
export const TABLES_TO_MOVE = [
  'kysely_migration',
  'kysely_migration_lock',
  'session',
  'session_folder',
  'space_aggregate',
  'space',
  'space_revision',
  'implementation_plan_grant',
  'implementation_plan_dispatch',
  'turn',
  'turn_thread',
  'session_event',
  'thread_context_log',
  'thread_capability_state',
  'model_provider',
  'skill',
  'sandbox_provider',
  'agent',
  'schedule',
  'schedule_run',
  'personalization_profile',
  'persona',
  'persona_name_key',
  'session_persona',
  'mcp_server',
  'mcp_tool_grant',
  'google_connection',
  'google_oauth_pending',
  'oauth_token',
  'oauth_pending_authorization',
  'repository',
  'repository_verify_command',
  'repository_verify_command_proposal',
  'command_execution',
  'repository_workspace_verification',
  'artifact_blob',
  'turn_artifact',
  'chat_image',
  'chat_image_turn_allowance',
  'approval_dismissal',
  'chat_search_document',
  'global_settings',
  'token_factory_usage',
  'token_factory_model_usage',
  'sentinel_audit',
  'sentinel_user_settings',
  'approval_token',
  'brief_item_completion',
] as const;

/**
 * Creates the `trueforge` schema if it is missing and moves every table in
 * `TABLES_TO_MOVE` out of `public` into it.
 *
 * Idempotent and safe to re-run on a database that partially migrated: a
 * table already moved (present in `trueforge`, absent from `public`) or
 * never created yet (absent from both) is left alone. Only a table still
 * sitting in `public` and not yet in `trueforge` is moved, one straggler at
 * a time, so a deploy that lands new fork tables after this function first
 * ran still gets them relocated instead of being skipped because the schema
 * already exists. `ALTER TABLE ... SET SCHEMA` carries the table's indexes,
 * constraints, and any sequence it owns (identity/serial columns) with it,
 * so those never need a separate move; no fork migration creates a
 * standalone sequence, view, or function in `public`.
 */
export async function ensureTrueforgeSchema(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async txn => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(txn);
    await sql`SELECT pg_advisory_xact_lock(hashtext('trueforge_schema_bootstrap'))`.execute(txn);

    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(TRUEFORGE_SCHEMA)}`.execute(txn);

    const located = await sql<{ schemaname: string; tablename: string }>`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname IN ('public', ${TRUEFORGE_SCHEMA})
        AND tablename = ANY(${TABLES_TO_MOVE})
    `.execute(txn);

    const inPublic = new Set<string>();
    const inTrueforge = new Set<string>();
    for (const row of located.rows) {
      if (row.schemaname === 'public') {
        inPublic.add(row.tablename);
      } else if (row.schemaname === TRUEFORGE_SCHEMA) {
        inTrueforge.add(row.tablename);
      }
    }

    for (const tableName of TABLES_TO_MOVE) {
      if (!inPublic.has(tableName) || inTrueforge.has(tableName)) {
        continue;
      }
      await sql`
        ALTER TABLE ${sql.id('public', tableName)} SET SCHEMA ${sql.id(TRUEFORGE_SCHEMA)}
      `.execute(txn);
    }
  });
}
