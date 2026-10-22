import type { Kysely, Selectable, Transaction } from 'kysely';
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
import { json, now } from '../sqlExpressions';
import type { Database, PersonalizationProfileTable } from '../types';

function toRecord(row: Selectable<PersonalizationProfileTable>): PersonalizationProfile {
  return {
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    assistant_name: row.assistant_name,
    assistant_identity: row.assistant_identity,
    voice_guidance: row.voice_guidance,
    user_name: row.user_name,
    address_as: row.address_as,
    user_profile: row.user_profile,
    pinned_preferences: row.pinned_preferences,
    help_areas: row.help_areas,
    learned_profile: row.learned_profile,
    learning_enabled: row.learning_enabled,
    revision: row.revision,
    digest: row.digest,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

function content(input: PersonalizationProfileContent): PersonalizationProfileContent {
  return normalizePersonalizationContent(input);
}

export class PostgresPersonalizationStore implements IPersonalizationStore<Transaction<Database>> {
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
      .selectAll()
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
    if (existing) {
      const update = db
        .updateTable('personalization_profile')
        .set({
          assistant_name: normalized.assistant_name,
          assistant_identity: normalized.assistant_identity,
          voice_guidance: normalized.voice_guidance,
          user_name: normalized.user_name,
          address_as: normalized.address_as,
          user_profile: normalized.user_profile,
          pinned_preferences: json(normalized.pinned_preferences),
          help_areas: json(normalized.help_areas),
          learned_profile: normalized.learned_profile,
          learning_enabled: normalized.learning_enabled,
          revision: existing.revision + 1,
          digest: personalizationDigest(normalized),
          updated_at: now(),
          updated_by: input.updated_by,
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by);
      if (typeof expectedRevision !== 'number') {
        const row = await update.returningAll().executeTakeFirstOrThrow();
        return toRecord(row);
      }
      // The fence is enforced in the statement itself, not just by the read above, so a write
      // that lands between the two loses cleanly instead of being overwritten.
      const row = await update.where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
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
      user_name: normalized.user_name,
      address_as: normalized.address_as,
      user_profile: normalized.user_profile,
      pinned_preferences: json(normalized.pinned_preferences),
      help_areas: json(normalized.help_areas),
      learned_profile: normalized.learned_profile,
      learning_enabled: normalized.learning_enabled,
      revision: 1,
      digest: personalizationDigest(normalized),
      created_at: now(),
      updated_at: now(),
      updated_by: input.updated_by,
    });
    if (expectedRevision === undefined) {
      const row = await insert.returningAll().executeTakeFirstOrThrow();
      return toRecord(row);
    }
    // Fenced create: a row that appeared since the read above is a conflict, never an overwrite.
    const row = await insert
      .onConflict(oc => oc.columns(['tenant_id', 'created_by']).doNothing())
      .returningAll()
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
