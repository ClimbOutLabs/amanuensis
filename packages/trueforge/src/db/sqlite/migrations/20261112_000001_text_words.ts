import { sql, type Kysely } from 'kysely';

/**
 * The words a person lets Aman text besides the common words, such as a name. One row per person and word, so adding
 * or removing a word never rewrites the others. Kept apart from `text_contact`, so changing a number never loses them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE text_word (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        word TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, word)
      ) STRICT
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE text_word`.execute(trx);
  });
}
