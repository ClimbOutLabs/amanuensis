import { createHash } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';
import {
  type ITurnArtifactStore,
  type RecordSkippedArtifactInput,
  type RecordStoredArtifactInput,
  type TenantScopedInput,
  type TurnArtifactIdentityInput,
  type TurnArtifactRecord,
} from '../../turnArtifactStore';
import { now } from '../sqlExpressions';
import type { Database, TurnArtifactTable } from '../types';

function toRecord(row: Selectable<TurnArtifactTable>): TurnArtifactRecord {
  return {
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    path: row.path,
    name: row.name,
    status: row.status,
    digest: row.digest,
    size: row.size,
    mime: row.mime,
    skip_reason: row.skip_reason,
    created_at: row.created_at.toISOString(),
  };
}

export class PostgresTurnArtifactStore implements ITurnArtifactStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async recordStoredArtifact(
    input: RecordStoredArtifactInput,
    transaction?: Transaction<Database>,
  ): Promise<TurnArtifactRecord> {
    return await this.#write(transaction, async trx => {
      const digest = createHash('sha256').update(input.data).digest('hex');
      await trx
        .insertInto('artifact_blob')
        .values({
          tenant_id: input.tenant_id,
          digest,
          size: input.data.length,
          mime: input.mime,
          data: input.data,
          created_at: now(),
        })
        .onConflict(oc => oc.columns(['tenant_id', 'digest']).doNothing())
        .execute();
      const row = await trx
        .insertInto('turn_artifact')
        .values({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          turn_id: input.turn_id,
          path: input.path,
          name: input.name,
          status: 'stored',
          digest,
          size: input.data.length,
          mime: input.mime,
          skip_reason: null,
          created_at: now(),
        })
        .onConflict(oc =>
          oc.columns(['tenant_id', 'session_id', 'turn_id', 'path']).doUpdateSet({
            name: input.name,
            status: 'stored',
            digest,
            size: input.data.length,
            mime: input.mime,
            skip_reason: null,
            created_at: now(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async recordSkippedArtifact(
    input: RecordSkippedArtifactInput,
    transaction?: Transaction<Database>,
  ): Promise<TurnArtifactRecord> {
    return await this.#write(transaction, async trx => {
      const row = await trx
        .insertInto('turn_artifact')
        .values({
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          turn_id: input.turn_id,
          path: input.path,
          name: input.name,
          status: input.status,
          digest: null,
          size: input.size ?? null,
          mime: null,
          skip_reason: input.skip_reason,
          created_at: now(),
        })
        .onConflict(oc =>
          oc.columns(['tenant_id', 'session_id', 'turn_id', 'path']).doUpdateSet({
            name: input.name,
            status: input.status,
            digest: null,
            size: input.size ?? null,
            mime: null,
            skip_reason: input.skip_reason,
            created_at: now(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRecord(row);
    });
  }

  async getArtifact(
    input: TurnArtifactIdentityInput,
    transaction?: Transaction<Database>,
  ): Promise<TurnArtifactRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('turn_artifact')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .where('path', '=', input.path)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async getBlob(
    input: TenantScopedInput & { digest: string },
    transaction?: Transaction<Database>,
  ): Promise<Buffer | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('artifact_blob')
      .select('data')
      .where('tenant_id', '=', input.tenant_id)
      .where('digest', '=', input.digest)
      .executeTakeFirst();
    return row?.data;
  }

  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().execute(run);
  }
}
