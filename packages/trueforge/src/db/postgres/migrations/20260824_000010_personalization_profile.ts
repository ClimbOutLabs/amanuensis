import { sql, type Kysely } from 'kysely';

/** Local per-user assistant/user profile. No session or conversation data is copied here. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema
    .createTable('personalization_profile')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('assistant_name', 'text')
    .addColumn('assistant_identity', 'text')
    .addColumn('voice_guidance', 'text')
    .addColumn('user_profile', 'text')
    .addColumn('pinned_preferences', 'jsonb', col => col.notNull())
    .addColumn('revision', 'integer', col => col.notNull())
    .addColumn('digest', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_at', 'timestamptz', col => col.notNull())
    .addColumn('updated_by', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('personalization_profile_pkey', ['tenant_id', 'created_by'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropTable('personalization_profile').ifExists().execute();
}
