/**
 * Notifications API (mounted at /api/v1/notifications).
 *
 * Notifications are owned by the subject that created them: listing is scoped
 * to the caller's own notifications, and read/delete are owner-only. Schedule
 * runs write notifications owned by the schedule creator, so each user only
 * ever sees their own reminders, briefings, and run notices.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { RequestContext, ResolveRequestContext } from '../auth/identity';
import type { INotificationStore, NotificationRecord } from '../db/notificationStore';
import {
  deleteNotificationRoute,
  listNotificationsRoute,
  markNotificationReadRoute,
} from '../routes/notificationRoutes';
import type { Notification } from '../schemas/notification';

const FORBIDDEN_NOTIFICATION_ACCESS = 'Only the notification owner can access this notification';

/** Notifications remain owner-only in every auth mode. */
function isNotificationOwner(
  requestContext: Pick<RequestContext, 'subject'>,
  created_by_subject_id: string,
): boolean {
  return requestContext.subject.id === created_by_subject_id;
}

function toWireNotification(record: NotificationRecord): Notification {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    schedule_id: record.schedule_id,
    schedule_run_id: record.schedule_run_id,
    created_by_subject: record.created_by_subject,
    read_at: record.read_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export interface NotificationsRouterDeps<TTransaction> {
  notificationStore: INotificationStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

export function createNotificationsRouter<TTransaction>(deps: NotificationsRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listNotificationsRoute> = async c => {
    const { limit, page_token: pageToken } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const { data, pagination } = await deps.notificationStore.listNotifications({
      tenant_id: requestContext.tenant_id,
      limit,
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
      created_by_subject_id: requestContext.subject.id,
    });
    return c.json({ data: data.map(toWireNotification), pagination }, 200);
  };

  const markReadHandler: RouteHandler<typeof markNotificationReadRoute> = async c => {
    const { notification_id: notificationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.notificationStore.getNotification({
      tenant_id: requestContext.tenant_id,
      id: notificationId,
    });
    if (record === undefined) {
      return c.json({ error: { message: `Notification not found: ${notificationId}` } }, 404);
    }
    if (!isNotificationOwner(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_NOTIFICATION_ACCESS } }, 403);
    }
    const updated = await deps.notificationStore.markNotificationRead({
      tenant_id: requestContext.tenant_id,
      id: notificationId,
    });
    if (updated === undefined) {
      return c.json({ error: { message: `Notification not found: ${notificationId}` } }, 404);
    }
    return c.json({ data: toWireNotification(updated) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteNotificationRoute> = async c => {
    const { notification_id: notificationId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.notificationStore.getNotification({
      tenant_id: requestContext.tenant_id,
      id: notificationId,
    });
    if (record === undefined) {
      // Idempotent: deleting an already-gone notification still reports success.
      return c.json({}, 200);
    }
    if (!isNotificationOwner(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_NOTIFICATION_ACCESS } }, 403);
    }
    await deps.notificationStore.deleteNotification({
      tenant_id: requestContext.tenant_id,
      id: notificationId,
    });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listNotificationsRoute, listHandler);
  router.openapi(markNotificationReadRoute, markReadHandler);
  router.openapi(deleteNotificationRoute, deleteHandler);
  return router;
}
