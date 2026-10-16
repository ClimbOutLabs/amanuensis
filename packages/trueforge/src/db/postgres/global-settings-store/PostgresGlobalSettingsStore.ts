import type { Kysely, Transaction } from 'kysely';

import type {
  GetGlobalSettingInput,
  GlobalSettingRecord,
  IGlobalSettingsStore,
  SetGlobalSettingInput,
} from '../../globalSettingsStore';
import { now } from '../sqlExpressions';
import type { Database, GlobalSettingsTable } from '../types';

function toRecord(row: GlobalSettingsTable): GlobalSettingRecord {
  return {
    key: row.key,
    value: row.value,
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresGlobalSettingsStore implements IGlobalSettingsStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getSetting(
    input: GetGlobalSettingInput,
    transaction?: Transaction<Database>,
  ): Promise<GlobalSettingRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db.selectFrom('global_settings').selectAll().where('key', '=', input.key).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async setSetting(input: SetGlobalSettingInput, transaction?: Transaction<Database>): Promise<GlobalSettingRecord> {
    return await this.#write(transaction, async trx => {
      const row = await trx
        .insertInto('global_settings')
        .values({ key: input.key, value: input.value, updated_at: now() })
        .onConflict(oc => oc.column('key').doUpdateSet({ value: input.value, updated_at: now() }))
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async listSettings(transaction?: Transaction<Database>): Promise<GlobalSettingRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db.selectFrom('global_settings').selectAll().orderBy('key', 'asc').execute();
    return rows.map(toRecord);
  }

  async deleteSetting(input: GetGlobalSettingInput, transaction?: Transaction<Database>): Promise<void> {
    await this.#write(transaction, async trx => {
      await trx.deleteFrom('global_settings').where('key', '=', input.key).execute();
    });
  }

  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().execute(run);
  }
}
