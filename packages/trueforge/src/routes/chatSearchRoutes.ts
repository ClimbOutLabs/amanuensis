import { createRoute } from '@hono/zod-openapi';
import { SearchOwnChatsRequestQuerySchema, SearchOwnChatsResponseSchema } from '../schemas/chatSearch';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const searchOwnChatsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Search the words inside your own chats',
  description:
    'Finds your own chats with a message holding every search word, newest match first, with a short excerpt. Returns nothing while past-chat search is off.',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'search_own_chats',
  request: { query: SearchOwnChatsRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SearchOwnChatsResponseSchema } },
      description: 'Matching chats.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The search was blank or too long.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});
