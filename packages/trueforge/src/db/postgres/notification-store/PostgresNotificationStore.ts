import type { CreatedBySubject, TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newId } from '../../../utils/id';
import { NotificationKindSchema } from '../../../schemas/notification';
import {
  type CreateNotificationInput,
  type DeleteNotificationInput,
  type GetNotificationInput,
  type INotificationStore,
  type ListNotificationsInput,
  type MarkNotificationReadInput,
  type NotificationRecord,
} from '../../notificationStore';
import { now } from '../sqlExpressions';
import type { Database, NotificationTable } from '../types';

function toNotificationRecord(row: NotificationTable): NotificationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: NotificationKindSchema.parse(row.kind),
    title: row.title,
    body: row.body,
    schedule_id: row.schedule_id,
    schedule_run_id: row.schedule_run_id,
    created_by_subject: row.created_by_subject,
    read_at: row.read_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class PostgresNotificationStore implements INotificationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createNotification(
    input: CreateNotificationInput,
    transaction?: Transaction<Database>,
  ): Promise<NotificationRecord> {
    const db = transaction ?? this.#db;
    const row = await db
      .insertInto('notification')
      .values({
        id: newId(),
        tenant_id: input.tenant_id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        schedule_id: input.schedule_id ?? null,
        schedule_run_id: input.schedule_run_id ?? null,
        created_by_subject: input.created_by_subject,
        read_at: null,
        created_at: now(),
        updated_at: now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toNotificationRecord(row);
  }

  async listNotifications(
    input: ListNotificationsInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: NotificationRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    let query = db.selectFrom('notification').selectAll().where('tenant_id', '=', input.tenant_id);
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`created_by_subject->>'subject_id'`, '=', input.created_by_subject_id);
    }
    // Unread first, then newest first.
    const rows = await query
      .orderBy(sql`(read_at IS NULL)`, 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(input.limit + 1)
      .offset(offset)
      .execute();
    const { data, pagination } = paginateOffsetRows(rows, input.limit, offset);
    return { data: data.map(toNotificationRecord), pagination };
  }

  async getNotification(
    input: GetNotificationInput,
    transaction?: Transaction<Database>,
  ): Promise<NotificationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('notification')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return row === undefined ? undefined : toNotificationRecord(row);
  }

  async markNotificationRead(
    input: MarkNotificationReadInput,
    transaction?: Transaction<Database>,
  ): Promise<NotificationRecord | undefined> {
    const db = transaction ?? this.#db;
    const row = await db
      .updateTable('notification')
      .set({ read_at: now(), updated_at: now() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toNotificationRecord(row);
  }

  async deleteNotification(
    input: DeleteNotificationInput,
    transaction?: Transaction<Database>,
  ): Promise<boolean> {
    const db = transaction ?? this.#db;
    const result = await db
      .deleteFrom('notification')
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
