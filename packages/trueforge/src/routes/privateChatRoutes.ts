import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const SweepPrivateChatsResponseSchema = z
  .object({
    deleted: z.number().int().nonnegative().describe('Private chats deleted because they expired.'),
  })
  .openapi('SweepPrivateChatsResponse');

export const sweepPrivateChatsRoute = createRoute({
  method: 'post',
  path: '/sweep',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Delete expired private chats',
  description: 'Delete private chats whose expiry time has passed. Safe to call any time.',
  'x-fern-sdk-group-name': ['internal', 'private_chats'],
  'x-fern-sdk-method-name': 'sweep',
  responses: {
    200: {
      content: { 'application/json': { schema: SweepPrivateChatsResponseSchema } },
      description: 'Sweep finished.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid service credential.',
    },
  },
});
