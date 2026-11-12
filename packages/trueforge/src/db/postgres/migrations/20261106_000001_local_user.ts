import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The one person who signs in with a password Aman keeps itself (local sign-in). The store keeps this
 * to a single row. `session_version` goes up whenever the password changes or is reset, so every
 * session issued before that stops working.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('local_user')
      .addColumn('id', 'text', col => col.notNull().primaryKey())
      .addColumn('email', 'text', col => col.notNull())
      .addColumn('password_hash', 'text', col => col.notNull())
      .addColumn('session_version', 'integer', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addColumn('updated_at', 'timestamptz', col => col.notNull())
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('local_user').execute();
  });
}
