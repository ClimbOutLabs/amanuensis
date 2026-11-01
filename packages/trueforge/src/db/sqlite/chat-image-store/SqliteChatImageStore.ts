import { sql, type Kysely, type Transaction } from 'kysely';

import type { ChatImageRecord, ChatImageWithData, IChatImageStore, PutChatImageInput } from '../../chatImageStore';
import { nowIso } from '../sqlExpressions';
import type { ChatImageTable, Database } from '../types';

const RECORD_COLUMNS = [
  'tenant_id',
  'created_by',
  'session_id',
  'turn_id',
  'image_id',
  'source_key',
  'origin',
  'mime',
  'width',
  'height',
  'size',
  'created_at',
] as const;

function toRecord(row: Omit<ChatImageTable, 'data'>): ChatImageRecord {
  return {
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    session_id: row.session_id,
    turn_id: row.turn_id,
    image_id: row.image_id,
    source_key: row.source_key,
    origin: row.origin,
    mime: row.mime,
    width: row.width,
    height: row.height,
    size: row.size,
    created_at: row.created_at,
  };
}

export class SqliteChatImageStore implements IChatImageStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async putImage(input: PutChatImageInput, transaction?: Transaction<Database>): Promise<ChatImageRecord> {
    const write = async (trx: Transaction<Database>): Promise<ChatImageRecord> => {
      const inserted = await trx
        .insertInto('chat_image')
        .values({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          session_id: input.session_id,
          turn_id: input.turn_id,
          image_id: input.image_id,
          source_key: input.source_key,
          origin: input.origin,
          mime: input.mime,
          width: input.width,
          height: input.height,
          size: input.data.byteLength,
          data: input.data,
          created_at: nowIso(),
        })
        .onConflict(oc => oc.columns(['session_id', 'source_key']).doNothing())
        .returning(RECORD_COLUMNS)
        .executeTakeFirst();
      const row =
        inserted ??
        (await trx
          .selectFrom('chat_image')
          .select(RECORD_COLUMNS)
          .where('session_id', '=', input.session_id)
          .where('source_key', '=', input.source_key)
          .executeTakeFirstOrThrow());
      // Newest first: every image past the point where the running total exceeds the cap goes.
      await sql`
        DELETE FROM chat_image
        WHERE (session_id, image_id) IN (
          SELECT session_id, image_id FROM (
            SELECT session_id, image_id,
              SUM(size) OVER (ORDER BY created_at DESC, image_id DESC) AS running_total
            FROM chat_image
            WHERE tenant_id = ${input.tenant_id} AND created_by = ${input.created_by}
          ) ranked
          WHERE running_total > ${input.user_max_bytes}
        )
        AND NOT (session_id = ${row.session_id} AND image_id = ${row.image_id})
      `.execute(trx);
      return toRecord(row);
    };
    return transaction
      ? await write(transaction)
      : await this.#db.transaction().setAccessMode('read write').execute(write);
  }

  async getImage(
    input: { tenant_id: string; session_id: string; image_id: string },
    transaction?: Transaction<Database>,
  ): Promise<ChatImageWithData | undefined> {
    const row = await (transaction ?? this.#db)
      .selectFrom('chat_image')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('image_id', '=', input.image_id)
      .executeTakeFirst();
    return row === undefined ? undefined : { ...toRecord(row), data: row.data };
  }

  async findBySource(
    input: { tenant_id: string; session_id: string; source_key: string },
    transaction?: Transaction<Database>,
  ): Promise<ChatImageRecord | undefined> {
    const row = await (transaction ?? this.#db)
      .selectFrom('chat_image')
      .select(RECORD_COLUMNS)
      .where('tenant_id', '=', input.tenant_id)
      .where('session_id', '=', input.session_id)
      .where('source_key', '=', input.source_key)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async deleteImagesOlderThan(input: { older_than: string }, transaction?: Transaction<Database>): Promise<number> {
    const deleted = await (transaction ?? this.#db)
      .deleteFrom('chat_image')
      .where('created_at', '<', input.older_than)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}
