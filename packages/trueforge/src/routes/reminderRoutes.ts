import { createRoute } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import { ListRemindersResponseSchema } from '../schemas/reminders';
import { OpenApiTag } from './openapiTags';

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
    'Lists every reminder the signed-in person set, upcoming and past, with the chat they are delivered into.',
  'x-fern-sdk-group-name': ['reminders'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListRemindersResponseSchema } },
      description: 'Every reminder the signed-in person set.',
    },
    401: unauthorizedResponse,
  },
});
