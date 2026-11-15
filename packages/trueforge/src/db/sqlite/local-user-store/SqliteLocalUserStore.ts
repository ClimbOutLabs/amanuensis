import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import {
  LocalUserAlreadyExistsError,
  localUserRecordFromRow,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../localUserStore';
import type { Database } from '../types';

export class SqliteLocalUserStore implements ILocalUserStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getUser(): Promise<LocalUserRecord | undefined> {
    const row = await this.#db.selectFrom('local_user').selectAll().executeTakeFirst();
    return row === undefined ? undefined : localUserRecordFromRow(row);
  }

  async createUser(record: LocalUserRecord): Promise<void> {
    await this.#db.transaction().execute(async trx => {
      const existing = await trx.selectFrom('local_user').select('id').executeTakeFirst();
      if (existing !== undefined) {
        throw new LocalUserAlreadyExistsError();
      }
      await trx
        .insertInto('local_user')
        .values({
          id: record.id,
          email: record.email,
          password_hash: record.password_hash,
          session_version: record.session_version,
          created_at: record.created_at,
          updated_at: record.updated_at,
        })
        .execute();
    });
  }

  async replacePasswordHash(input: { password_hash: string; updated_at: string }): Promise<boolean> {
    const result = await this.#db
      .updateTable('local_user')
      .set({
        password_hash: input.password_hash,
        updated_at: input.updated_at,
        session_version: sql<number>`session_version + 1`,
      })
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
