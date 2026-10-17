import type { Kysely, Transaction } from 'kysely';

import type {
  CompareAndSetGlobalSettingInput,
  GetGlobalSettingInput,
  GlobalSettingRecord,
  IGlobalSettingsStore,
  SetGlobalSettingInput,
} from '../../globalSettingsStore';
import { nowIso } from '../sqlExpressions';
import type { Database, GlobalSettingsTable } from '../types';

function toRecord(row: GlobalSettingsTable): GlobalSettingRecord {
  return {
    key: row.key,
    value: row.value,
    updated_at: row.updated_at,
  };
}

export class SqliteGlobalSettingsStore implements IGlobalSettingsStore<Transaction<Database>> {
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
      const timestamp = nowIso();
      const row = await trx
        .insertInto('global_settings')
        .values({ key: input.key, value: input.value, updated_at: timestamp })
        .onConflict(oc => oc.column('key').doUpdateSet({ value: input.value, updated_at: timestamp }))
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async deleteSetting(input: GetGlobalSettingInput, transaction?: Transaction<Database>): Promise<void> {
    await this.#write(transaction, async trx => {
      await trx.deleteFrom('global_settings').where('key', '=', input.key).execute();
    });
  }

  async compareAndSetSetting(
    input: CompareAndSetGlobalSettingInput,
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const { key, expected, value } = input;
    return await this.#write(transaction, async trx => {
      if (expected === null) {
        if (value === null) {
          return (await this.getSetting({ key }, trx)) === undefined;
        }
        const inserted = await trx
          .insertInto('global_settings')
          .values({ key, value, updated_at: nowIso() })
          .onConflict(oc => oc.column('key').doNothing())
          .executeTakeFirst();
        return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
      }
      if (value === null) {
        const deleted = await trx
          .deleteFrom('global_settings')
          .where('key', '=', key)
          .where('value', '=', expected)
          .executeTakeFirst();
        return deleted.numDeletedRows > 0n;
      }
      const updated = await trx
        .updateTable('global_settings')
        .set({ value, updated_at: nowIso() })
        .where('key', '=', key)
        .where('value', '=', expected)
        .executeTakeFirst();
      return updated.numUpdatedRows > 0n;
    });
  }

  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().setAccessMode('read write').execute(run);
  }
}
