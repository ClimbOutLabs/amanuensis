/**
 * In-app notifications written by schedule runs (reminders, briefings, and
 * completion/failure notices) and surfaced in the UI notification bell.
 */
import { z } from '@hono/zod-openapi';
import {
  CreatedBySubjectSchema,
  TokenPaginationSchema,
} from '@truefoundry/trueforge-core/agent-session';

/**
 * How the notification was produced.
 * - `reminder` a reminder schedule fired; the body is the schedule task
 * - `briefing` a briefing schedule finished; the body is the generated briefing
 * - `schedule_complete` a session schedule run finished and `notify_on_completion` was set
 * - `schedule_failed` a schedule run failed and `notify_on_failure` was set
 */
export const NotificationKindSchema = z
  .enum(['reminder', 'briefing', 'schedule_complete', 'schedule_failed'])
  .openapi('NotificationKind');

/**
 * Wire ISO-8601 instant on a response. Always UTC with milliseconds — every
 * timestamp the server emits comes from `Date.prototype.toISOString()`.
 */
const IsoTimestamp = z.iso.datetime().openapi({ type: 'string', format: 'date-time' });

const NullableIsoTimestamp = z.iso
  .datetime()
  .nullable()
  .openapi({ type: ['string', 'null'], format: 'date-time' });

export const NotificationSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    kind: NotificationKindSchema,
    title: z.string(),
    body: z.string(),
    schedule_id: z.string().nullable(),
    schedule_run_id: z.string().nullable(),
    created_by_subject: CreatedBySubjectSchema,
    read_at: NullableIsoTimestamp,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .strict()
  .openapi('Notification');

export const ListNotificationsResponseSchema = z
  .object({
    data: z.array(NotificationSchema),
    pagination: TokenPaginationSchema,
  })
  .openapi('ListNotificationsResponse');

export const GetNotificationResponseSchema = z
  .object({ data: NotificationSchema })
  .openapi('GetNotificationResponse');

export const DeleteNotificationResponseSchema = z.object({}).openapi('DeleteNotificationResponse');

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
