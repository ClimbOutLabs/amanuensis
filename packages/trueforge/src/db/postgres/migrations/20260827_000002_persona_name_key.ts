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
  if (!isStringArray(value)) {
    throw new Error('cannot backfill persona names: persona.aliases must be an array of strings');
  }
  return value;
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
      const reservationKey = `${row.tenant_id}\u0000${row.created_by}\u0000${normalized_key}`;
      const existing = reservations.get(reservationKey);
      if (existing !== undefined && existing.persona_id !== row.id) {
        const owners = collisions.get(reservationKey) ?? new Set([existing.persona_id]);
        owners.add(row.id);
        collisions.set(reservationKey, owners);
        continue;
      }
      reservations.set(reservationKey, {
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

/** Completes the persona schema introduced by 000001 for existing installations. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  const result = await sql<PersonaRow>`
    SELECT tenant_id, id, created_by, display_name, aliases
    FROM persona
    ORDER BY tenant_id, created_by, id
  `.execute(db);
  const reservations = buildReservations(result.rows);

  await sql`ALTER TABLE persona ADD CONSTRAINT persona_owner_id_key UNIQUE (tenant_id, created_by, id)`.execute(db);
  await db.schema
    .createTable('persona_name_key')
    .addColumn('tenant_id', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull())
    .addColumn('normalized_key', 'text', col => col.notNull())
    .addColumn('persona_id', 'text', col => col.notNull())
    .addPrimaryKeyConstraint('persona_name_key_pkey', ['tenant_id', 'created_by', 'normalized_key'])
    .addForeignKeyConstraint(
      'persona_name_key_persona_fkey',
      ['tenant_id', 'created_by', 'persona_id'],
      'persona',
      ['tenant_id', 'created_by', 'id'],
      constraint => constraint.onDelete('cascade'),
    )
    .execute();
  await insertReservations(db, reservations);
  await db.schema
    .createIndex('persona_name_key_persona_idx')
    .on('persona_name_key')
    .columns(['tenant_id', 'persona_id'])
    .execute();
  await sql`
    ALTER TABLE session_persona
      ADD CONSTRAINT session_persona_session_fkey
      FOREIGN KEY (session_id) REFERENCES session(session_id) ON DELETE CASCADE
  `.execute(db);
  await db.schema.createIndex('session_persona_session_idx').on('session_persona').column('session_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.dropIndex('session_persona_session_idx').ifExists().execute();
  await sql`ALTER TABLE session_persona DROP CONSTRAINT IF EXISTS session_persona_session_fkey`.execute(db);
  await db.schema.dropTable('persona_name_key').ifExists().execute();
  await sql`ALTER TABLE persona DROP CONSTRAINT IF EXISTS persona_owner_id_key`.execute(db);
}
