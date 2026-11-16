import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import {
  LocalUserAlreadyExistsError,
  localUserRecordFromRow,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../localUserStore';
import { TerminalKeyStore } from '../../terminalKeyStore';
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

  async replacePasswordHashAndRevokeTerminalKeys(input: {
    password_hash: string;
    tenant_id: string;
    subject_id: string;
    revoked_at: string;
  }): Promise<{ replaced: boolean; revoked_count: number }> {
    return this.#db.transaction().execute(async trx => {
      // Stamped here, inside the transaction: terminal key validation refuses a
      // key claimed at or before this moment, so it must be the write's own
      // moment, never one the caller minted before the write began.
      const updated_at = new Date().toISOString();
      const result = await trx
        .updateTable('local_user')
        .set({
          password_hash: input.password_hash,
          updated_at,
          session_version: sql<number>`session_version + 1`,
        })
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        return { replaced: false, revoked_count: 0 };
      }
      // The revocation runs on the same transaction, through the key store that
      // owns the table, so it commits or rolls back with the password itself. The
      // transaction is named as a Kysely of this database first: the key store
      // speaks the narrower shape, and a transaction only widens to its own.
      const executor: Kysely<Database> = trx;
      const revoked_count = await new TerminalKeyStore(executor).revokeAllForOwner({
        tenant_id: input.tenant_id,
        subject_id: input.subject_id,
        revoked_at: input.revoked_at,
      });
      return { replaced: true, revoked_count };
    });
  }
}
