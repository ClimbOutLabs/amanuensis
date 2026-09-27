/**
 * Notification route definitions (mounted at /api/v1/notifications).
 * Handlers are registered in apis/notifications.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PAGE_LIMIT } from '../schemas/common';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  DeleteNotificationResponseSchema,
  GetNotificationResponseSchema,
  ListNotificationsResponseSchema,
} from '../schemas/notification';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

export const NotificationIdParamsSchema = z.object({
  notification_id: z.string().min(1).max(64).describe('Immutable notification identifier.'),
});

export const ListNotificationsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT)
      .optional()
      .default(PAGE_LIMIT)
      .describe(`Page size. Defaults to ${String(PAGE_LIMIT)}`),
    page_token: z.string().optional().describe('Opaque token from a previous response `next_page_token`.'),
  })
  .openapi('ListNotificationsQuery');

export const listNotificationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.NOTIFICATIONS],
  summary: 'List notifications',
  description: 'List notifications for the tenant, unread first and then newest first.',
  'x-fern-sdk-group-name': ['notifications'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: {
    query: ListNotificationsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ListNotificationsResponseSchema } },
      description: 'Paginated matching notifications.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unauthenticated.',
    },
  },
});

export const markNotificationReadRoute = createRoute({
  method: 'put',
  path: '/{notification_id}/read',
  tags: [OpenApiTag.NOTIFICATIONS],
  summary: 'Mark a notification as read',
  description: 'Mark a notification as read. Idempotent.',
  'x-fern-sdk-group-name': ['notifications'],
  'x-fern-sdk-method-name': 'mark_read',
  request: {
    params: NotificationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetNotificationResponseSchema } },
      description: 'The notification after marking it read.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unauthenticated.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The caller is not the notification owner.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Not found.',
    },
  },
});

export const deleteNotificationRoute = createRoute({
  method: 'delete',
  path: '/{notification_id}',
  tags: [OpenApiTag.NOTIFICATIONS],
  summary: 'Delete a notification',
  description: 'Delete a notification. Idempotent.',
  'x-fern-sdk-group-name': ['notifications'],
  'x-fern-sdk-method-name': 'delete',
  request: {
    params: NotificationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteNotificationResponseSchema } },
      description: 'Deleted.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Unauthenticated.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The caller is not the notification owner.',
    },
  },
});
