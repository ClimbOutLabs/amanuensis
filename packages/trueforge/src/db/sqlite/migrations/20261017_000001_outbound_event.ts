import { sql, type Kysely } from 'kysely';

/**
 * Record of requests that left this computer: model requests, emails, searches, map lookups and
 * connector calls. Hosts and sizes only, never request text. Mirrors
 * db/postgres/migrations/20261017_000001_outbound_event.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE outbound_event (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model_request', 'email_sent', 'web_search', 'map_lookup', 'connector_call')),
        host TEXT NOT NULL,
        model TEXT,
        tool_name TEXT,
        request_bytes INTEGER,
        recipient_count INTEGER,
        subject TEXT,
        conversation_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX outbound_event_created_idx ON outbound_event (tenant_id, created_at DESC)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE outbound_event`.execute(trx);
  });
}
