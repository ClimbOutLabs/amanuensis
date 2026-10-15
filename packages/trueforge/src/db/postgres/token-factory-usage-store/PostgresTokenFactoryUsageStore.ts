import type { Kysely, Transaction } from 'kysely';

import type {
  AddTokenFactoryUsageInput,
  GetTokenFactoryUsageInput,
  ITokenFactoryUsageStore,
  TokenFactoryUsageRecord,
} from '../../tokenFactoryUsageStore';
import { now } from '../sqlExpressions';
import type { Database, TokenFactoryUsageTable } from '../types';

function toRecord(row: TokenFactoryUsageTable): TokenFactoryUsageRecord {
  return { usage_date: row.usage_date, used_tokens: row.used_tokens, updated_at: row.updated_at.toISOString() };
}

export class PostgresTokenFactoryUsageStore implements ITokenFactoryUsageStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getUsage(
    input: GetTokenFactoryUsageInput,
    transaction?: Transaction<Database>,
  ): Promise<TokenFactoryUsageRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('token_factory_usage')
      .selectAll()
      .where('usage_date', '=', input.usage_date)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async addUsage(input: AddTokenFactoryUsageInput, transaction?: Transaction<Database>): Promise<TokenFactoryUsageRecord> {
    const write = async (trx: Transaction<Database>) => {
      const row = await trx
        .insertInto('token_factory_usage')
        .values({ usage_date: input.usage_date, used_tokens: input.tokens, updated_at: now() })
        .onConflict(oc =>
          oc.column('usage_date').doUpdateSet(eb => ({
            used_tokens: eb('token_factory_usage.used_tokens', '+', input.tokens),
            updated_at: now(),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    };
    return transaction ? await write(transaction) : await this.#db.transaction().execute(write);
  }
}
