import type { ExpressionBuilder, Kysely, Transaction } from 'kysely';
import {
  isPersonalizationUnchanged,
  normalizePersonalizationContent,
  personalizationDigest,
  type PersonalizationProfile,
  type PersonalizationProfileContent,
} from '../../../personalization/profile';
import {
  PersonalizationRevisionConflictError,
  type DeletePersonalizationProfileInput,
  type GetPersonalizationProfileInput,
  type IPersonalizationStore,
  type UpsertPersonalizationProfileInput,
} from '../../personalizationStore';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

function recordColumns(eb: ExpressionBuilder<Database, 'personalization_profile'>) {
  return [
    'tenant_id' as const,
    'created_by' as const,
    'assistant_name' as const,
    'assistant_identity' as const,
    'voice_guidance' as const,
    'user_profile' as const,
    jsonText<string[]>(eb.ref('pinned_preferences')).as('pinned_preferences'),
    'learned_profile' as const,
    'learning_enabled' as const,
    'revision' as const,
    'digest' as const,
    'created_at' as const,
    'updated_at' as const,
    'updated_by' as const,
  ];
}

/** A selected row, with SQLite's 0/1 integer standing in for the boolean column. */
type PersonalizationRow = Omit<PersonalizationProfile, 'learning_enabled'> & { learning_enabled: number };

function toRecord(row: PersonalizationRow): PersonalizationProfile {
  return { ...row, learning_enabled: row.learning_enabled === 1 };
}

function content(input: PersonalizationProfileContent): PersonalizationProfileContent {
  return normalizePersonalizationContent(input);
}

export class SqlitePersonalizationStore implements IPersonalizationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getProfile(
    input: GetPersonalizationProfileInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonalizationProfile | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('personalization_profile')
      .select(recordColumns)
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async upsertProfile(
    input: UpsertPersonalizationProfileInput,
    transaction?: Transaction<Database>,
  ): Promise<PersonalizationProfile> {
    const db = transaction ?? this.#db;
    const normalized = content(input);
    const expectedRevision = input.expected_revision;
    const existing = await this.getProfile({ tenant_id: input.tenant_id, created_by: input.created_by }, transaction);
    if (expectedRevision !== undefined) {
      const matches = expectedRevision === null ? existing === undefined : existing?.revision === expectedRevision;
      if (!matches) {
        throw new PersonalizationRevisionConflictError({
          created_by: input.created_by,
          expected_revision: expectedRevision,
        });
      }
    }
    if (existing !== undefined && isPersonalizationUnchanged({ existing, next: normalized })) {
      return existing;
    }
    const timestamp = nowIso();
    if (existing) {
      const update = db
        .updateTable('personalization_profile')
        .set({
          assistant_name: normalized.assistant_name,
          assistant_identity: normalized.assistant_identity,
          voice_guidance: normalized.voice_guidance,
          user_profile: normalized.user_profile,
          pinned_preferences: jsonbBind(normalized.pinned_preferences),
          learned_profile: normalized.learned_profile,
          learning_enabled: normalized.learning_enabled ? 1 : 0,
          revision: existing.revision + 1,
          digest: personalizationDigest(normalized),
          updated_at: timestamp,
          updated_by: input.updated_by,
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by);
      if (typeof expectedRevision !== 'number') {
        return toRecord(await update.returning(recordColumns).executeTakeFirstOrThrow());
      }
      // The fence is enforced in the statement itself, not just by the read above, so a write
      // that lands between the two loses cleanly instead of being overwritten.
      const row = await update.where('revision', '=', expectedRevision).returning(recordColumns).executeTakeFirst();
      if (row === undefined) {
        throw new PersonalizationRevisionConflictError({
          created_by: input.created_by,
          expected_revision: expectedRevision,
        });
      }
      return toRecord(row);
    }
    const insert = db.insertInto('personalization_profile').values({
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      assistant_name: normalized.assistant_name,
      assistant_identity: normalized.assistant_identity,
      voice_guidance: normalized.voice_guidance,
      user_profile: normalized.user_profile,
      pinned_preferences: jsonbBind(normalized.pinned_preferences),
      learned_profile: normalized.learned_profile,
      learning_enabled: normalized.learning_enabled ? 1 : 0,
      revision: 1,
      digest: personalizationDigest(normalized),
      created_at: timestamp,
      updated_at: timestamp,
      updated_by: input.updated_by,
    });
    if (expectedRevision === undefined) {
      return toRecord(await insert.returning(recordColumns).executeTakeFirstOrThrow());
    }
    // Fenced create: a row that appeared since the read above is a conflict, never an overwrite.
    const row = await insert
      .onConflict(oc => oc.columns(['tenant_id', 'created_by']).doNothing())
      .returning(recordColumns)
      .executeTakeFirst();
    if (row === undefined) {
      throw new PersonalizationRevisionConflictError({
        created_by: input.created_by,
        expected_revision: expectedRevision,
      });
    }
    return toRecord(row);
  }

  async deleteProfile(input: DeletePersonalizationProfileInput, transaction?: Transaction<Database>): Promise<void> {
    const db = transaction ?? this.#db;
    await db
      .deleteFrom('personalization_profile')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .execute();
  }
}
