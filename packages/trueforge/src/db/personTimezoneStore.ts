import type { Kysely } from 'kysely';

import type { PersonOwner } from './personOwner';

/** One row of `person_timezone`: the time zone a person's browser last gave. */
export interface PersonTimezoneTable {
  tenant_id: string;
  created_by: string;
  timezone: string;
  updated_at: string | Date;
}

export interface PersonTimezoneDatabase {
  person_timezone: PersonTimezoneTable;
}

/**
 * The time zone each person's browser last gave, kept so a message that brings none, such as one from Telegram,
 * can still be read in the person's own day. Owner-scoped: no read or write reaches another person's row.
 */
export interface IPersonTimezoneStore {
  get(owner: PersonOwner): Promise<string | undefined>;
  /** Keeps the zone, replacing the one kept before. */
  put(input: PersonOwner & { timezone: string; now?: Date }): Promise<void>;
}

export class PersonTimezoneStore implements IPersonTimezoneStore {
  readonly #db: Kysely<PersonTimezoneDatabase>;

  constructor(db: Kysely<PersonTimezoneDatabase>) {
    this.#db = db;
  }

  async get(owner: PersonOwner): Promise<string | undefined> {
    const row = await this.#db
      .selectFrom('person_timezone')
      .select('timezone')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row?.timezone;
  }

  async put(input: PersonOwner & { timezone: string; now?: Date }): Promise<void> {
    const updated_at = (input.now ?? new Date()).toISOString();
    await this.#db
      .insertInto('person_timezone')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, timezone: input.timezone, updated_at })
      .onConflict(conflict =>
        conflict.columns(['tenant_id', 'created_by']).doUpdateSet({ timezone: input.timezone, updated_at }),
      )
      .execute();
  }
}
