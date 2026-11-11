import { sql, type Kysely } from 'kysely';

import { withMigrationTransaction } from '../migrationTransaction';

/**
 * The words a person lets Aman text besides the common words, such as a name. One row per person and word, so adding
 * or removing a word never rewrites the others. Kept apart from `text_contact`, so changing a number never loses them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema
      .createTable('text_word')
      .addColumn('tenant_id', 'text', col => col.notNull())
      .addColumn('created_by', 'text', col => col.notNull())
      .addColumn('word', 'text', col => col.notNull())
      .addColumn('created_at', 'timestamptz', col => col.notNull())
      .addPrimaryKeyConstraint('text_word_pk', ['tenant_id', 'created_by', 'word'])
      .execute();
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await withMigrationTransaction(db, async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await trx.schema.dropTable('text_word').execute();
  });
}
