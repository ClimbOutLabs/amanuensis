import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import {
  normalizePersonaContent,
  parsePersonaActivationSource,
  personaNameKeys,
  type Persona,
  type PersonaActivation,
  type PersonaContent,
} from '../../../personas/persona';
import {
  PersonaNameConflictError,
  type CreatePersonaInput,
  type DeletePersonaInput,
  type GetPersonaInput,
  type GetSessionPersonaInput,
  type GetTurnPersonaActivationInput,
  type IPersonaStore,
  type IsManualSessionPersonaCurrentInput,
  type ListPersonasInput,
  type ListSessionPersonaActivationsInput,
  type RecordPersonaActivationIfManualCurrentInput,
  type RecordPersonaActivationInput,
  type UpdatePersonaInput,
} from '../../personaStore';
import { isUniqueViolation } from '../client';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

function personaColumns(eb: ExpressionBuilder<Database, 'persona'>) {
  return [
    'tenant_id' as const,
    'id' as const,
    'created_by' as const,
    'display_name' as const,
    jsonText<string[]>(eb.ref('aliases')).as('aliases'),
    'instructions' as const,
    'model_name' as const,
    'created_at' as const,
    'updated_at' as const,
    'updated_by' as const,
  ];
}

const ACTIVATION_COLUMNS = [
  'id',
  'tenant_id',
  'session_id',
  'seq',
  'turn_id',
  'persona_id',
  'persona_name',
  'model_name',
  'source',
  'created_at',
] as const;

function toActivation(row: {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  model_name: string | null;
  source: string;
  created_at: string;
}): PersonaActivation {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    persona_id: row.persona_id,
    persona_name: row.persona_name,
    model_name: row.model_name,
    source: parsePersonaActivationSource(row.source),
    created_at: row.created_at,
  };
}

export class SqlitePersonaStore implements IPersonaStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async listPersonas(input: ListPersonasInput, transaction?: Transaction<Database>): Promise<Persona[]> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('persona')
      .select(personaColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('display_name')
      .execute();
  }

  async getPersona(input: GetPersonaInput, transaction?: Transaction<Database>): Promise<Persona | undefined> {
    const db = transaction ?? this.#db;
    return await db
      .selectFrom('persona')
      .select(personaColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.id)
      .executeTakeFirst();
  }

  async createPersona(input: CreatePersonaInput, transaction?: Transaction<Database>): Promise<Persona> {
    return await this.#write(transaction, async trx => {
      const content = normalizePersonaContent(input);
      const timestamp = nowIso();
      const row = await trx
        .insertInto('persona')
        .values({
          tenant_id: input.tenant_id,
          id: input.id,
          created_by: input.created_by,
          display_name: content.display_name,
          aliases: jsonbBind(content.aliases),
          instructions: content.instructions,
          model_name: content.model_name,
          created_at: timestamp,
          updated_at: timestamp,
          updated_by: input.updated_by,
        })
        .returning(personaColumns)
        .executeTakeFirstOrThrow();
      await this.#reserveNames({ owner: input, content, trx });
      return row;
    });
  }

  async updatePersona(input: UpdatePersonaInput, transaction?: Transaction<Database>): Promise<Persona | undefined> {
    return await this.#write(transaction, async trx => {
      // Existence first: "no such persona" is the useful answer when the target
      // is gone, even if the names in the body happen to belong to another one.
      if ((await this.getPersona(input, trx)) === undefined) {
        return undefined;
      }
      const content = normalizePersonaContent(input);
      const row = await trx
        .updateTable('persona')
        .set({
          display_name: content.display_name,
          aliases: jsonbBind(content.aliases),
          instructions: content.instructions,
          model_name: content.model_name,
          updated_at: nowIso(),
          updated_by: input.updated_by,
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('id', '=', input.id)
        .returning(personaColumns)
        .executeTakeFirst();
      await trx
        .deleteFrom('persona_name_key')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('persona_id', '=', input.id)
        .execute();
      await this.#reserveNames({ owner: input, content, trx });
      return row;
    });
  }

  async deletePersona(input: DeletePersonaInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .deleteFrom('persona')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.id)
      .execute();
  }

  async getSessionPersona(
    input: GetSessionPersonaInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('session_persona')
      .select(ACTIVATION_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toActivation(row);
  }

  async getLatestManualSessionPersona(
    input: GetSessionPersonaInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('session_persona')
      .select(ACTIVATION_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', 'is', null)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toActivation(row);
  }

  async getTurnPersonaActivation(
    input: GetTurnPersonaActivationInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('session_persona')
      .select(ACTIVATION_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toActivation(row);
  }

  async getLatestManualSessionPersonaAfterTurn(
    input: GetTurnPersonaActivationInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation | undefined> {
    const db = transaction ?? this.#db;
    const parent = await db
      .selectFrom('session_persona')
      .select('seq')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (parent === undefined) {
      return undefined;
    }
    const row = await db
      .selectFrom('session_persona')
      .select(ACTIVATION_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', 'is', null)
      .where('seq', '>', parent.seq)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toActivation(row);
  }

  async isManualSessionPersonaCurrent(
    input: IsManualSessionPersonaCurrentInput,
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    return await this.#write(transaction, async trx => {
      if ((await this.#lockSession(input, trx)) === undefined) {
        return false;
      }
      const current = await this.getLatestManualSessionPersona(input, trx);
      return (current?.id ?? null) === input.expected_activation_id;
    });
  }

  async listSessionPersonaActivations(
    input: ListSessionPersonaActivationsInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('session_persona')
      .select(ACTIVATION_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .orderBy('seq', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(toActivation);
  }

  async recordPersonaActivationIfManualCurrent(
    input: RecordPersonaActivationIfManualCurrentInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation | undefined> {
    return await this.#write(transaction, async trx => {
      if ((await this.#lockSession(input, trx)) === undefined) {
        throw new Error(`Session not found: ${input.session_id}`);
      }
      const current = await this.getLatestManualSessionPersona(input, trx);
      if ((current?.id ?? null) !== input.expected_activation_id) {
        return undefined;
      }
      return await this.#insertPersonaActivation(input, trx);
    });
  }

  async recordPersonaActivation(
    input: RecordPersonaActivationInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonaActivation> {
    return await this.#write(transaction, async trx => {
      // The SQLite FK is intentionally session_id-only because that is the
      // session table's key. Prove tenant ownership in the same IMMEDIATE
      // transaction before allocating a sequence so a caller cannot attach an
      // activation to another tenant's session by knowing its id.
      if ((await this.#lockSession(input, trx)) === undefined) {
        throw new Error(`Session not found: ${input.session_id}`);
      }
      return await this.#insertPersonaActivation(input, trx);
    });
  }

  async #insertPersonaActivation(
    input: RecordPersonaActivationInput,
    trx: Transaction<Database>,
  ): Promise<PersonaActivation> {
    const row = await trx
      .insertInto('session_persona')
      .values({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        seq: await this.#nextSeq(input, trx),
        id: input.id,
        turn_id: input.turn_id,
        persona_id: input.persona_id,
        persona_name: input.persona_name,
        model_name: input.model_name,
        source: input.source,
        created_at: nowIso(),
      })
      .returning(ACTIVATION_COLUMNS)
      .executeTakeFirstOrThrow();
    return toActivation(row);
  }

  /**
   * Next slot in this chat's log, read inside the same transaction as the
   * insert. Two decisions in the same millisecond would be indistinguishable
   * by timestamp or ulid; a colliding seq is a primary-key error rather than a
   * silently reordered history.
   */
  async #nextSeq(input: { tenant_id: string; session_id: string }, trx: Transaction<Database>): Promise<number> {
    const latest = await trx
      .selectFrom('session_persona')
      .select('seq')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    return (latest?.seq ?? 0) + 1;
  }

  /** SQLite uses a no-op write to take the same session lock as turn admission. */
  async #lockSession(
    input: GetSessionPersonaInput,
    trx: Transaction<Database>,
  ): Promise<{ session_id: string } | undefined> {
    return await trx
      .updateTable('session')
      .set({ last_turn_id: sql<string | null>`last_turn_id` })
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .returning('session_id')
      .executeTakeFirst();
  }

  /** Name reservations and the persona write must not be separable, so both run in one transaction. */
  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().setAccessMode('read write').execute(run);
  }

  async #reserveNames(input: {
    owner: GetPersonaInput;
    content: PersonaContent;
    trx: Transaction<Database>;
  }): Promise<void> {
    const keys = personaNameKeys(input.content);
    try {
      await input.trx
        .insertInto('persona_name_key')
        .values(
          keys.map(normalized_key => ({
            tenant_id: input.owner.tenant_id,
            created_by: input.owner.created_by,
            normalized_key,
            persona_id: input.owner.id,
          })),
        )
        .execute();
    } catch (error) {
      // Only the authoritative reservation insert maps to a name conflict.
      if (isUniqueViolation(error)) {
        throw new PersonaNameConflictError(keys);
      }
      throw error;
    }
  }
}
