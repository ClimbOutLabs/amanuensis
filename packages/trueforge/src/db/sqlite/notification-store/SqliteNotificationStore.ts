import {
  CreatedBySubjectSchema,
  type CreatedBySubject,
  type TokenPagination,
} from '@truefoundry/trueforge-core/agent-session';
import {
  decodeOffsetPageToken,
  paginateOffsetRows,
} from '@truefoundry/trueforge-core/agent-session/store/OffsetPageToken';
import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import { newId } from '../../../utils/id';
import {
  type CreateNotificationInput,
  type DeleteNotificationInput,
  type GetNotificationInput,
  type INotificationStore,
  type ListNotificationsInput,
  type MarkNotificationReadInput,
  type NotificationRecord,
} from '../../notificationStore';
import { NotificationKindSchema } from '../../../schemas/notification';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database, NotificationTable } from '../types';

type NotificationRow = Pick<
  NotificationTable,
  | 'id'
  | 'tenant_id'
  | 'kind'
  | 'title'
  | 'body'
  | 'schedule_id'
  | 'schedule_run_id'
  | 'read_at'
  | 'created_at'
  | 'updated_at'
> & { created_by_subject: CreatedBySubject };

/** Column list projecting the JSON `created_by_subject` as parsed JSON (see JSON_RESULT_COLUMNS). */
function notificationColumns(eb: ExpressionBuilder<Database, 'notification'>) {
  return [
    'id' as const,
    'tenant_id' as const,
    'kind' as const,
    'title' as const,
    'body' as const,
    'schedule_id' as const,
    'schedule_run_id' as const,
    jsonText<CreatedBySubject>(eb.ref('created_by_subject')).as('created_by_subject'),
    'read_at' as const,
    'created_at' as const,
    'updated_at' as const,
  ];
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    ...row,
    kind: NotificationKindSchema.parse(row.kind),
    created_by_subject: CreatedBySubjectSchema.parse(row.created_by_subject),
  };
}

export class SqliteNotificationStore implements INotificationStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async createNotification(
    input: CreateNotificationInput,
    transaction?: Transaction<Database>,
  ): Promise<NotificationRecord> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
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
        created_by_subject: jsonbBind(input.created_by_subject),
        read_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning(notificationColumns)
      .executeTakeFirstOrThrow();
    return toNotificationRecord(row);
  }

  async listNotifications(
    input: ListNotificationsInput,
    transaction?: Transaction<Database>,
  ): Promise<{ data: NotificationRecord[]; pagination: TokenPagination }> {
    const offset = decodeOffsetPageToken(input.page_token);
    const db = transaction ?? this.#db;
    let query = db
      .selectFrom('notification')
      .select(notificationColumns)
      .where('tenant_id', '=', input.tenant_id);
    if (input.created_by_subject_id !== undefined) {
      query = query.where(sql`json_extract(created_by_subject, '$.subject_id')`, '=', input.created_by_subject_id);
    }
    // Unread first, then newest first. `read_at` sorts nulls first in ascending
    // order in SQLite; the explicit expression keeps the intent readable.
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
      .select(notificationColumns)
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
      .set({ read_at: nowIso(), updated_at: nowIso() })
      .where('tenant_id', '=', input.tenant_id)
      .where('id', '=', input.id)
      .returning(notificationColumns)
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
