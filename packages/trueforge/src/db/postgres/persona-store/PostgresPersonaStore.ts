import type { Kysely, Selectable, Transaction } from 'kysely';
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
import { json, now } from '../sqlExpressions';
import type { Database, PersonaTable, SessionPersonaTable } from '../types';

function toPersona(row: Selectable<PersonaTable>): Persona {
  return {
    tenant_id: row.tenant_id,
    id: row.id,
    created_by: row.created_by,
    display_name: row.display_name,
    aliases: row.aliases,
    instructions: row.instructions,
    model_name: row.model_name,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

function toActivation(row: Selectable<SessionPersonaTable>): PersonaActivation {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    persona_id: row.persona_id,
    persona_name: row.persona_name,
    model_name: row.model_name,
    source: parsePersonaActivationSource(row.source),
    created_at: row.created_at.toISOString(),
  };
}

export class PostgresPersonaStore implements IPersonaStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async listPersonas(input: ListPersonasInput, transaction?: Transaction<Database>): Promise<Persona[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('persona')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .orderBy('display_name')
      .execute();
    return rows.map(toPersona);
  }

  async getPersona(input: GetPersonaInput, transaction?: Transaction<Database>): Promise<Persona | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('persona')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toPersona(row);
  }

  async createPersona(input: CreatePersonaInput, transaction?: Transaction<Database>): Promise<Persona> {
    return await this.#write(transaction, async trx => {
      const content = normalizePersonaContent(input);
      const row = await trx
        .insertInto('persona')
        .values({
          tenant_id: input.tenant_id,
          id: input.id,
          created_by: input.created_by,
          display_name: content.display_name,
          aliases: json(content.aliases),
          instructions: content.instructions,
          model_name: content.model_name,
          created_at: now(),
          updated_at: now(),
          updated_by: input.updated_by,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.#reserveNames({ owner: input, content, trx });
      return toPersona(row);
    });
  }

  async updatePersona(input: UpdatePersonaInput, transaction?: Transaction<Database>): Promise<Persona | undefined> {
    return await this.#write(transaction, async trx => {
      // Existence first: "no such persona" is the useful answer when the target
      // is gone, even if the names in the body happen to belong to another one.
      const existing = await trx
        .selectFrom('persona')
        .select('id')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('id', '=', input.id)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        return undefined;
      }
      const content = normalizePersonaContent(input);
      const row = await trx
        .updateTable('persona')
        .set({
          display_name: content.display_name,
          aliases: json(content.aliases),
          instructions: content.instructions,
          model_name: content.model_name,
          updated_at: now(),
          updated_by: input.updated_by,
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('id', '=', input.id)
        .returningAll()
        .executeTakeFirst();
      await trx
        .deleteFrom('persona_name_key')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('persona_id', '=', input.id)
        .execute();
      await this.#reserveNames({ owner: input, content, trx });
      return row === undefined ? undefined : toPersona(row);
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
      .selectAll()
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
      .selectAll()
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
      .selectAll()
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
      .selectAll()
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
      .selectAll()
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
        created_at: now(),
      })
      .returningAll()
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

  async #lockSession(
    input: GetSessionPersonaInput,
    trx: Transaction<Database>,
  ): Promise<{ session_id: string } | undefined> {
    return await trx
      .selectFrom('session')
      .select('session_id')
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Name reservations and the persona write must not be separable, so both run in one transaction. */
  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().execute(run);
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
      // Other uniqueness failures (for example, a duplicate persona id) keep
      // their original database error and cannot be misreported as a name.
      if (isUniqueViolation(error)) {
        throw new PersonaNameConflictError(keys);
      }
      throw error;
    }
  }
}
