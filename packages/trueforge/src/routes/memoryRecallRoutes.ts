/** Memory recall switch routes (mounted at /api/v1/settings/memory-recalls). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetMemoryRecallResponseSchema, UpdateMemoryRecallRequestSchema } from '../schemas/memoryRecall';
import { OpenApiTag } from './openapiTags';

export const getMemoryRecallRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the memory recall switch',
  description: 'Whether replies use saved memories for every chat. `enabled` is null when the switch was never set.',
  'x-fern-sdk-group-name': ['settings', 'memoryRecalls'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryRecallResponseSchema } },
      description: 'The stored memory recall switch.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});

export const putMemoryRecallRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the memory recall switch',
  description:
    'Sets whether replies use saved memories in every chat, including chats with a saved agent. `null` clears the switch so each agent follows its own setting.',
  'x-fern-sdk-group-name': ['settings', 'memoryRecalls'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryRecallRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryRecallResponseSchema } },
      description: 'The stored memory recall switch after the update.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});
