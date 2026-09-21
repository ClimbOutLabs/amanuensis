import { sql, type Kysely } from 'kysely';

import { personaNameKeys } from '../../../personas/persona';

interface PersonaRow {
  tenant_id: string;
  id: string;
  created_by: string;
  display_name: string;
  aliases: unknown;
}

interface NameReservation {
  tenant_id: string;
  created_by: string;
  normalized_key: string;
  persona_id: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((alias: unknown) => typeof alias === 'string');
}

function parseAliases(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error('cannot backfill persona names: persona.aliases is not valid JSON', { cause: error });
    }
  } else if (value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(value)) as unknown;
    } catch (error) {
      throw new Error('cannot backfill persona names: persona.aliases is not valid JSON', { cause: error });
    }
  }
  if (!isStringArray(parsed)) {
    throw new Error('cannot backfill persona names: persona.aliases must be an array of strings');
  }
  return parsed;
}

function buildReservations(rows: PersonaRow[]): NameReservation[] {
  const reservations = new Map<string, NameReservation>();
  const collisions = new Map<string, Set<string>>();

  for (const row of rows) {
    const keys = new Set(
      personaNameKeys({
        display_name: row.display_name,
        aliases: parseAliases(row.aliases),
        instructions: '',
        model_name: '',
      }),
    );
    if (keys.size === 0) {
      throw new Error(`cannot backfill persona names: persona ${row.id} has no usable name`);
    }
    for (const normalized_key of keys) {
      const existing = reservations.get(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`);
      if (existing !== undefined && existing.persona_id !== row.id) {
        const owners =
          collisions.get(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`) ??
          new Set([existing.persona_id]);
        owners.add(row.id);
        collisions.set(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`, owners);
        continue;
      }
      reservations.set(`${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`, {
        tenant_id: row.tenant_id,
        created_by: row.created_by,
        normalized_key,
        persona_id: row.id,
      });
    }
  }

  if (collisions.size > 0) {
    const details = [...collisions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, owners]) => `${key.replaceAll('\u0000', '/')}: ${[...owners].sort().join(', ')}`)
      .join('; ');
    throw new Error(`cannot backfill persona names: normalized-name collisions must be resolved first (${details})`);
  }
  return [...reservations.values()];
}

async function insertReservations(trx: Kysely<unknown>, reservations: NameReservation[]): Promise<void> {
  if (reservations.length === 0) {
    return;
  }
  await sql`
    INSERT INTO persona_name_key (tenant_id, created_by, normalized_key, persona_id)
    VALUES ${sql.join(
      reservations.map(row => sql`(${row.tenant_id}, ${row.created_by}, ${row.normalized_key}, ${row.persona_id})`),
    )}
  `.execute(trx);
}

/**
 * Completes the persona schema introduced by 000001 without editing that
 * already-applied migration. Existing names are checked in stable ID order;
 * normalized collisions abort the transaction rather than assigning ownership
 * nondeterministically or changing user data.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      const result = await sql<PersonaRow>`
        SELECT tenant_id, id, created_by, display_name, json(aliases) AS aliases
        FROM persona
        ORDER BY tenant_id, created_by, id
      `.execute(trx);
      const reservations = buildReservations(result.rows);

      await sql`
        CREATE UNIQUE INDEX persona_owner_id_key
          ON persona (tenant_id, created_by, id)
      `.execute(trx);
      await sql`
        CREATE TABLE persona_name_key (
          tenant_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          normalized_key TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, created_by, normalized_key),
          FOREIGN KEY (tenant_id, created_by, persona_id)
            REFERENCES persona(tenant_id, created_by, id) ON DELETE CASCADE
        ) STRICT
      `.execute(trx);
      await insertReservations(trx, reservations);
      await sql`
        CREATE INDEX persona_name_key_persona_idx
          ON persona_name_key (tenant_id, persona_id)
      `.execute(trx);

      await sql`
        CREATE TABLE session_persona_new (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(session_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          turn_id TEXT,
          persona_id TEXT,
          persona_name TEXT,
          model_name TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, session_id, seq)
        ) STRICT
      `.execute(trx);
      await sql`
        INSERT INTO session_persona_new
          (tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at)
        SELECT tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at
        FROM session_persona
      `.execute(trx);
      await sql`DROP TABLE session_persona`.execute(trx);
      await sql`ALTER TABLE session_persona_new RENAME TO session_persona`.execute(trx);
      await sql`CREATE INDEX session_persona_session_idx ON session_persona (session_id)`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async trx => {
      await sql`DROP INDEX IF EXISTS session_persona_session_idx`.execute(trx);
      await sql`
        CREATE TABLE session_persona_old (
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          turn_id TEXT,
          persona_id TEXT,
          persona_name TEXT,
          model_name TEXT,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, session_id, seq)
        ) STRICT
      `.execute(trx);
      await sql`
        INSERT INTO session_persona_old
          (tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at)
        SELECT tenant_id, session_id, seq, id, turn_id, persona_id, persona_name, model_name, source, created_at
        FROM session_persona
      `.execute(trx);
      await sql`DROP TABLE session_persona`.execute(trx);
      await sql`ALTER TABLE session_persona_old RENAME TO session_persona`.execute(trx);
      await sql`DROP TABLE IF EXISTS persona_name_key`.execute(trx);
      await sql`DROP INDEX IF EXISTS persona_owner_id_key`.execute(trx);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}
