import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import {
  LocalUserAlreadyExistsError,
  localUserRecordFromRow,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../localUserStore';
import { isUniqueViolation } from '../client';
import type { Database } from '../types';

export class PostgresLocalUserStore implements ILocalUserStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getUser(): Promise<LocalUserRecord | undefined> {
    const row = await this.#db.selectFrom('local_user').selectAll().executeTakeFirst();
    return row === undefined ? undefined : localUserRecordFromRow(row);
  }

  async createUser(record: LocalUserRecord): Promise<void> {
    try {
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
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two first-run creates raced past the check above and the table's unique
        // singleton index refused the second row. That is the same refusal the check
        // makes, in the words the rest of the app already speaks.
        throw new LocalUserAlreadyExistsError({ cause: error });
      }
      throw error;
    }
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
