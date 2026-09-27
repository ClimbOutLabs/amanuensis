import { sql, type Kysely } from 'kysely';

/**
 * User-configured personas and the per-session log of which one answered.
 *
 * `session_persona` is append-only: its highest-`seq` row is the chat's active
 * persona, and each row carrying a `turn_id` is that turn's provenance. It is
 * not a foreign key onto `persona` — deleting a persona must not erase the
 * record of turns it already answered.
 *
 * Ordering is `seq`, not a timestamp or a ulid: two decisions can land in the
 * same millisecond, and "which persona is active" must never depend on which
 * of two same-instant rows sorted first.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('persona')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('display_name', 'text', col => col.notNull())
    .addColumn('aliases', 'jsonb', col => col.notNull())
    .addColumn('instructions', 'text', col => col.notNull())
    .addColumn('model_name', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_by', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('persona_pkey', ['tenant_id', 'id'])
    .execute();
  await db.schema
    .createIndex('persona_owner_idx')
    .on('persona')
    .columns(['tenant_id', 'created_by', 'display_name'])
    .execute();

  await db.schema
    .createTable('session_persona')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('session_id', 'text', col => col.notNull())
    .addColumn('seq', 'integer', col => col.notNull())
    .addColumn('id', 'text', col => col.notNull())
    .addColumn('turn_id', 'text')
    .addColumn('persona_id', 'text')
    .addColumn('persona_name', 'text')
    .addColumn('model_name', 'text')
    .addColumn('source', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addPrimaryKeyConstraint('session_persona_pkey', ['tenant_id', 'session_id', 'seq'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('session_persona').ifExists().execute();
  await db.schema.dropTable('persona').ifExists().execute();
}
