import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { ListUserAuditLogRequestQuerySchema, ListUserAuditLogResponseSchema } from '../schemas/sentinelAudit';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

export const listUserAuditLogRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'List the Sentinel audit log across all chats',
  description:
    'Lists the authenticated user’s Sentinel audit entries from every chat, newest first, including chats that were deleted. Read-only and paged.',
  'x-fern-sdk-group-name': ['personalization', 'auditLog'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { query: ListUserAuditLogRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListUserAuditLogResponseSchema } },
      description: 'One page of audit entries.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters or page token.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});
