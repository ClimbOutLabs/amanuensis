import { sql, type Kysely } from 'kysely';

/** Durable spaces: a persistent, named, structured page the model creates and updates. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`
      CREATE TABLE space_aggregate (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (tenant_id, created_by)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE TABLE space (
        tenant_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        body TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, created_by, id)
      ) STRICT
    `.execute(trx);
    await sql`
      CREATE INDEX space_list_idx
      ON space (tenant_id, created_by, status, name, id)
    `.execute(trx);
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`DROP TABLE space`.execute(trx);
    await sql`DROP TABLE space_aggregate`.execute(trx);
  });
}
