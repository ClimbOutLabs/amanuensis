/**
 * DB-backed in-app notifications: one `notification` row per reminder, briefing,
 * or schedule completion/failure notice. Rows are owned by the subject that
 * created the schedule (or the schedule creator for run-derived notifications).
 *
 * Transactions are route-owned (see `WithTransaction`): a store method never opens
 * one. All methods accept an optional transaction for callers that batch writes.
 *
 * Implementations: PostgresNotificationStore and SqliteNotificationStore.
 */
import type {
  CreatedBySubject,
  TokenPagination,
} from '@truefoundry/trueforge-core/agent-session';
import type { NotificationKind } from '../schemas/notification';

export interface NotificationRecord {
  id: string;
  tenant_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  schedule_id: string | null;
  schedule_run_id: string | null;
  created_by_subject: CreatedBySubject;
  /** ISO-8601 UTC instant the notification was marked read; null while unread. */
  read_at: string | null;
  /** ISO-8601 UTC instant. */
  created_at: string;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface CreateNotificationInput {
  tenant_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  schedule_id?: string | null;
  schedule_run_id?: string | null;
  created_by_subject: CreatedBySubject;
}

export interface ListNotificationsInput {
  tenant_id: string;
  limit: number;
  page_token?: string | null;
  /** When set, only notifications created by this subject. */
  created_by_subject_id?: string;
  /**
   * When set, only notifications written for this schedule run. Used by
   * dispatch to keep reminder writes idempotent across re-fired runs.
   */
  schedule_run_id?: string | null;
}

export interface GetNotificationInput {
  tenant_id: string;
  id: string;
}

export interface MarkNotificationReadInput {
  tenant_id: string;
  id: string;
}

export interface DeleteNotificationInput {
  tenant_id: string;
  id: string;
}

/**
 * Notification persistence. Listing returns unread rows first, then newest
 * first, so the bell shows what still needs attention.
 */
export interface INotificationStore<TTransaction> {
  createNotification(
    input: CreateNotificationInput,
    transaction?: TTransaction,
  ): Promise<NotificationRecord>;
  listNotifications(
    input: ListNotificationsInput,
    transaction?: TTransaction,
  ): Promise<{ data: NotificationRecord[]; pagination: TokenPagination }>;
  getNotification(
    input: GetNotificationInput,
    transaction?: TTransaction,
  ): Promise<NotificationRecord | undefined>;
  markNotificationRead(
    input: MarkNotificationReadInput,
    transaction?: TTransaction,
  ): Promise<NotificationRecord | undefined>;
  deleteNotification(
    input: DeleteNotificationInput,
    transaction?: TTransaction,
  ): Promise<boolean>;
}
