import type { Kysely, Transaction } from 'kysely';

import type {
  AddTokenFactoryUsageInput,
  GetTokenFactoryUsageInput,
  ITokenFactoryUsageStore,
  TokenFactoryModelUsageRecord,
  TokenFactoryUsageRecord,
} from '../../tokenFactoryUsageStore';
import { now } from '../sqlExpressions';
import type { Database, TokenFactoryModelUsageTable, TokenFactoryUsageTable } from '../types';

function toRecord(row: TokenFactoryUsageTable): TokenFactoryUsageRecord {
  return { usage_date: row.usage_date, used_tokens: row.used_tokens, updated_at: row.updated_at.toISOString() };
}

function toModelRecord(row: TokenFactoryModelUsageTable): TokenFactoryModelUsageRecord {
  return {
    usage_date: row.usage_date,
    model_id: row.model_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    calls: row.calls,
  };
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

  async addUsage(
    input: AddTokenFactoryUsageInput,
    transaction?: Transaction<Database>,
  ): Promise<TokenFactoryUsageRecord> {
    const write = async (trx: Transaction<Database>) => {
      const tokens = input.input_tokens + input.output_tokens;
      await trx
        .insertInto('token_factory_model_usage')
        .values({
          usage_date: input.usage_date,
          model_id: input.model_id,
          input_tokens: input.input_tokens,
          output_tokens: input.output_tokens,
          calls: 1,
          updated_at: now(),
        })
        .onConflict(oc =>
          oc.columns(['usage_date', 'model_id']).doUpdateSet(eb => ({
            input_tokens: eb('token_factory_model_usage.input_tokens', '+', input.input_tokens),
            output_tokens: eb('token_factory_model_usage.output_tokens', '+', input.output_tokens),
            calls: eb('token_factory_model_usage.calls', '+', 1),
            updated_at: now(),
          })),
        )
        .execute();
      const row = await trx
        .insertInto('token_factory_usage')
        .values({ usage_date: input.usage_date, used_tokens: tokens, updated_at: now() })
        .onConflict(oc =>
          oc.column('usage_date').doUpdateSet(eb => ({
            used_tokens: eb('token_factory_usage.used_tokens', '+', tokens),
            updated_at: now(),
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    };
    return transaction ? await write(transaction) : await this.#db.transaction().execute(write);
  }

  async listModelUsage(
    input: GetTokenFactoryUsageInput,
    transaction?: Transaction<Database>,
  ): Promise<TokenFactoryModelUsageRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('token_factory_model_usage')
      .selectAll()
      .where('usage_date', '=', input.usage_date)
      .orderBy(eb => eb('input_tokens', '+', eb.ref('output_tokens')), 'desc')
      .orderBy('model_id')
      .execute();
    return rows.map(toModelRecord);
  }
}
