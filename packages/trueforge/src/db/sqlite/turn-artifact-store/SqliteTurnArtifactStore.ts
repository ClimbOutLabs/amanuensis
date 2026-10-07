import { createHash } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';
import {
  type ITurnArtifactStore,
  type RecordSkippedArtifactInput,
  type RecordStoredArtifactInput,
  type TenantScopedInput,
  type TurnArtifactIdentityInput,
  type TurnArtifactRecord,
} from '../../turnArtifactStore';
import { nowIso } from '../sqlExpressions';
import type { Database, TurnArtifactTable } from '../types';

function toRecord(row: TurnArtifactTable): TurnArtifactRecord {
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
    created_at: row.created_at,
  };
}

export class SqliteTurnArtifactStore implements ITurnArtifactStore<Transaction<Database>> {
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
      const timestamp = nowIso();
      await trx
        .insertInto('artifact_blob')
        .values({
          tenant_id: input.tenant_id,
          digest,
          size: input.data.length,
          mime: input.mime,
          data: input.data,
          created_at: timestamp,
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
          created_at: timestamp,
        })
        .onConflict(oc =>
          oc.columns(['tenant_id', 'session_id', 'turn_id', 'path']).doUpdateSet({
            name: input.name,
            status: 'stored',
            digest,
            size: input.data.length,
            mime: input.mime,
            skip_reason: null,
            created_at: timestamp,
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
      const timestamp = nowIso();
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
          created_at: timestamp,
        })
        .onConflict(oc =>
          oc.columns(['tenant_id', 'session_id', 'turn_id', 'path']).doUpdateSet({
            name: input.name,
            status: input.status,
            digest: null,
            size: input.size ?? null,
            mime: null,
            skip_reason: input.skip_reason,
            created_at: timestamp,
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

  async listArtifacts(
    input: TenantScopedInput & { session_id: string; turn_id: string },
    transaction?: Transaction<Database>,
  ): Promise<TurnArtifactRecord[]> {
    const db = transaction ?? this.#db;
    const rows = await db
      .selectFrom('turn_artifact')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('turn_id', '=', input.turn_id)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toRecord);
  }

  async deleteArtifactsOlderThan(
    input: { older_than: string },
    transaction?: Transaction<Database>,
  ): Promise<number> {
    return await this.#write(transaction, async trx => {
      const deleted = await trx
        .deleteFrom('turn_artifact')
        .where('created_at', '<', input.older_than)
        .executeTakeFirst();
      const deletedRows = Number(deleted.numDeletedRows);
      // Blobs are content-addressed and shared across turns: only delete a
      // blob when no surviving index row references its digest.
      await trx
        .deleteFrom('artifact_blob')
        .where(eb =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('turn_artifact as ta')
                .select('ta.digest')
                .whereRef('ta.tenant_id', '=', 'artifact_blob.tenant_id')
                .whereRef('ta.digest', '=', 'artifact_blob.digest'),
            ),
          ),
        )
        .execute();
      return deletedRows;
    });
  }

  async #write<T>(
    transaction: Transaction<Database> | undefined,
    run: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T> {
    return transaction ? await run(transaction) : await this.#db.transaction().setAccessMode('read write').execute(run);
  }
}
