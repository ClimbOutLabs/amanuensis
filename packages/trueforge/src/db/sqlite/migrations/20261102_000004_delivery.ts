import { sql, type Kysely } from 'kysely';

/**
 * The delivery feed and the devices that turned push notices on. `kind`, `level` and `channel` are plain text, with no
 * check, so a later kind or channel needs no migration. Deliveries and attempts are owner-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely's SqliteAdapter reports supportsTransactionalDdl: false, so every schema-touching migration opens its own transaction.
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE delivery (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        link TEXT,
        created_at TEXT NOT NULL,
        seen_at TEXT
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX delivery_owner_created_idx ON delivery (tenant_id, created_by, created_at, id)`.execute(trx);
    await sql`
      CREATE TABLE delivery_attempt (
        id TEXT NOT NULL PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES delivery (id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT,
        target TEXT,
        attempted_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`CREATE INDEX delivery_attempt_delivery_idx ON delivery_attempt (delivery_id)`.execute(trx);
    await sql`
      CREATE TABLE push_subscription (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`CREATE UNIQUE INDEX push_subscription_endpoint_uq ON push_subscription (endpoint)`.execute(trx);
    await sql`CREATE INDEX push_subscription_owner_idx ON push_subscription (tenant_id, created_by)`.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE push_subscription`.execute(trx);
    await sql`DROP TABLE delivery_attempt`.execute(trx);
    await sql`DROP TABLE delivery`.execute(trx);
  });
}
