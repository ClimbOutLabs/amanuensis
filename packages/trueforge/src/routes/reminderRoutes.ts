import { createRoute } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import { ListRemindersResponseSchema, RemindersPageQuerySchema } from '../schemas/reminders';
import { OpenApiTag } from './openapiTags';

const invalidRequestResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Invalid request.',
};

const unauthorizedResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'OIDC is configured and the request has no valid session cookie.',
};

export const listRemindersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.REMINDERS],
  summary: 'List reminders',
  description:
    'Lists the reminders the signed-in person set, upcoming and past, a page at a time, each with the chat it was set in.',
  'x-fern-sdk-group-name': ['reminders'],
  'x-fern-sdk-method-name': 'list',
  request: { query: RemindersPageQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListRemindersResponseSchema } },
      description: 'One page of the reminders the signed-in person set.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});
