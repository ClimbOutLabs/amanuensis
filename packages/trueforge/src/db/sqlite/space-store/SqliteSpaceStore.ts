import { sql, type Kysely, type Transaction } from 'kysely';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  type CreateSpaceInput,
  type DeleteSpaceInput,
  type ISpaceStore,
  type ListSpacesInput,
  type OwnerScopedInput,
  type SpaceAggregate,
  type SpaceDeleteResult,
  type SpaceIdentityInput,
  type SpaceListResult,
  type SpaceMutationResult,
  type SpaceRecord,
  type UpdateSpaceInput,
} from '../../spaceStore';
import { nowIso } from '../sqlExpressions';
import type { Database, SpaceTable } from '../types';

function toSpace(row: SpaceTable): SpaceRecord {
  return {
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    body: row.body,
    format: row.format,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteSpaceStore implements ISpaceStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async getAggregate(input: OwnerScopedInput, transaction?: Transaction<Database>): Promise<SpaceAggregate> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('space_aggregate')
      .select(['tenant_id', 'created_by', 'revision'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return row ?? { tenant_id: input.tenant_id, created_by: input.created_by, revision: 0 };
  }

  async listSpaces(input: ListSpacesInput, transaction?: Transaction<Database>): Promise<SpaceRecord[]> {
    const db = transaction ?? this.#db;
    let query = db
      .selectFrom('space')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by);
    if (input.status !== undefined) {
      query = query.where('status', '=', input.status);
    }
    return (
      await query
        .orderBy('name')
        .orderBy('id')
        .limit(input.limit)
        .offset(input.offset ?? 0)
        .execute()
    ).map(toSpace);
  }

  async listSpacesWithAggregate(input: ListSpacesInput, transaction?: Transaction<Database>): Promise<SpaceListResult> {
    return await this.#read(transaction, async trx => {
      const aggregate = await this.getAggregate(input, trx);
      const offset = input.offset ?? 0;
      // Fetch one extra row to detect truncation without a second count query.
      const rows = await this.listSpaces({ ...input, limit: input.limit + 1 }, trx);
      const has_more = rows.length > input.limit;
      return {
        records: has_more ? rows.slice(0, input.limit) : rows,
        aggregate_revision: aggregate.revision,
        has_more,
        next_offset: has_more ? offset + input.limit : null,
      };
    });
  }

  async getSpace(input: SpaceIdentityInput, transaction?: Transaction<Database>): Promise<SpaceRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('space')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('id', '=', input.space_id)
      .executeTakeFirst();
    return row === undefined ? undefined : toSpace(row);
  }

  async createSpace(input: CreateSpaceInput, transaction?: Transaction<Database>): Promise<SpaceMutationResult> {
    return await this.#write(transaction, async trx => {
      const aggregate_revision = await this.#advanceAggregate(input, trx);
      const timestamp = nowIso();
      const row = await trx
        .insertInto('space')
        .values({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          id: input.id,
          name: input.name,
          purpose: input.purpose,
          status: input.status,
          body: input.body,
          format: input.format,
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { record: toSpace(row), aggregate_revision };
    });
  }

  async updateSpace(input: UpdateSpaceInput, transaction?: Transaction<Database>): Promise<SpaceMutationResult> {
    return await this.#write(transaction, async trx => {
      const aggregate_revision = await this.#advanceAggregate(input, trx);
      const row = await trx
        .updateTable('space')
        .set({
          name: input.name,
          purpose: input.purpose,
          status: input.status,
          body: input.body,
          format: input.format,
          revision: sql<number>`revision + 1`,
          updated_at: nowIso(),
        })
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('id', '=', input.space_id)
        .where('revision', '=', input.expected_revision)
        .returningAll()
        .executeTakeFirst();
      if (row !== undefined) {
        return { record: toSpace(row), aggregate_revision };
      }
      return await this.#throwSpaceMutationFailure(input, trx);
    });
  }

  async deleteSpace(input: DeleteSpaceInput, transaction?: Transaction<Database>): Promise<SpaceDeleteResult> {
    return await this.#write(transaction, async trx => {
      const aggregate_revision = await this.#bumpAggregate(input, trx);
      const result = await trx
        .deleteFrom('space')
        .where('tenant_id', '=', input.tenant_id)
        .where('created_by', '=', input.created_by)
        .where('id', '=', input.space_id)
        .where('revision', '=', input.expected_revision)
        .executeTakeFirst();
      if (result.numDeletedRows > 0n) {
        return { aggregate_revision };
      }
      return await this.#throwSpaceMutationFailure(input, trx);
    });
  }

  async #throwSpaceMutationFailure(
    input: Pick<UpdateSpaceInput, 'tenant_id' | 'created_by' | 'space_id' | 'expected_revision'>,
    trx: Transaction<Database>,
  ): Promise<never> {
    const current = await this.getSpace(
      { tenant_id: input.tenant_id, created_by: input.created_by, space_id: input.space_id },
      trx,
    );
    if (current === undefined) {
      throw new SpaceNotFoundError({ id: input.space_id });
    }
    throw new SpaceRevisionConflictError({
      id: input.space_id,
      expected_revision: input.expected_revision,
      actual_revision: current.revision,
    });
  }

  async #advanceAggregate(
    input: OwnerScopedInput & { expected_aggregate_revision: number },
    trx: Transaction<Database>,
  ): Promise<number> {
    await trx
      .insertInto('space_aggregate')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, revision: 0 })
      .onConflict(oc => oc.columns(['tenant_id', 'created_by']).doNothing())
      .execute();
    const updated = await trx
      .updateTable('space_aggregate')
      .set({ revision: sql<number>`revision + 1` })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('revision', '=', input.expected_aggregate_revision)
      .returning('revision')
      .executeTakeFirst();
    if (updated !== undefined) {
      return updated.revision;
    }
    const current = await this.getAggregate({ tenant_id: input.tenant_id, created_by: input.created_by }, trx);
    throw new SpaceAggregateRevisionConflictError({
      expected_revision: input.expected_aggregate_revision,
      actual_revision: current.revision,
    });
  }

  /**
   * Unconditional aggregate advance for delete, which has no `expected_aggregate_revision` to
   * guard against (see `DeleteSpaceInput`). Still fences a racing paginated list the same way
   * `#advanceAggregate` does for create/update, just without a prior value to check.
   */
  async #bumpAggregate(input: OwnerScopedInput, trx: Transaction<Database>): Promise<number> {
    await trx
      .insertInto('space_aggregate')
      .values({ tenant_id: input.tenant_id, created_by: input.created_by, revision: 0 })
      .onConflict(oc => oc.columns(['tenant_id', 'created_by']).doNothing())
      .execute();
    const updated = await trx
      .updateTable('space_aggregate')
      .set({ revision: sql<number>`revision + 1` })
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .returning('revision')
      .executeTakeFirstOrThrow();
    return updated.revision;
  }

  async #read<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().setAccessMode('read only').execute(run);
  }

  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().setAccessMode('read write').execute(run);
  }
}
