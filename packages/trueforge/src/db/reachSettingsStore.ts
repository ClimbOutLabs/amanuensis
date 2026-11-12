import type { Kysely } from 'kysely';

import { ReachSettingsSchema, type ReachSettings } from '../schemas/reach';
import type { PersonOwner } from './personOwner';

/** One row of `reach_settings`: a person's whole Reach me document as JSON. */
export interface ReachSettingsTable {
  tenant_id: string;
  created_by: string;
  settings: string;
  updated_at: string | Date;
}

export interface ReachSettingsDatabase {
  reach_settings: ReachSettingsTable;
}

/** A person's Reach me settings. Owner-scoped: no read or write reaches another person's row. */
export interface IReachSettingsStore {
  /** The saved settings, or undefined while the person has never saved any. */
  get(owner: PersonOwner): Promise<ReachSettings | undefined>;
  /** Everyone who has saved settings, so the watchers also look after people with no Google login. */
  listOwners(): Promise<PersonOwner[]>;
  /** Replaces the person's settings. */
  put(input: PersonOwner & { settings: ReachSettings; now?: Date }): Promise<ReachSettings>;
  /** Adds exported settings when the person has none; settings already there are kept. Resolves to whether they were added. */
  importSettings(
    input: PersonOwner & { settings: ReachSettings; now?: Date },
    transaction?: Kysely<ReachSettingsDatabase>,
  ): Promise<boolean>;
}

export class ReachSettingsStore implements IReachSettingsStore {
  readonly #db: Kysely<ReachSettingsDatabase>;

  constructor(db: Kysely<ReachSettingsDatabase>) {
    this.#db = db;
  }

  async get(owner: PersonOwner): Promise<ReachSettings | undefined> {
    const row = await this.#db
      .selectFrom('reach_settings')
      .select('settings')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row === undefined ? undefined : ReachSettingsSchema.parse(JSON.parse(row.settings));
  }

  async listOwners(): Promise<PersonOwner[]> {
    return await this.#db
      .selectFrom('reach_settings')
      .select(['tenant_id', 'created_by'])
      .orderBy('tenant_id')
      .orderBy('created_by')
      .execute();
  }

  async put(input: PersonOwner & { settings: ReachSettings; now?: Date }): Promise<ReachSettings> {
    // Parsed before the write, so a document that could not be read back is never stored.
    const settings = ReachSettingsSchema.parse(input.settings);
    const updated_at = (input.now ?? new Date()).toISOString();
    const document = JSON.stringify(settings);
    await this.#db
      .insertInto('reach_settings')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, settings: document, updated_at })
      .onConflict(conflict =>
        conflict.columns(['tenant_id', 'created_by']).doUpdateSet({ settings: document, updated_at }),
      )
      .execute();
    return settings;
  }

  async importSettings(
    input: PersonOwner & { settings: ReachSettings; now?: Date },
    transaction?: Kysely<ReachSettingsDatabase>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const settings = ReachSettingsSchema.parse(input.settings);
    const inserted = await db
      .insertInto('reach_settings')
      .values({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        settings: JSON.stringify(settings),
        updated_at: (input.now ?? new Date()).toISOString(),
      })
      .onConflict(conflict => conflict.columns(['tenant_id', 'created_by']).doNothing())
      .returning('created_by')
      .execute();
    return inserted.length > 0;
  }
}
