/** Turn-summarization setting routes (mounted at /api/v1/settings/memory-summarize). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetMemorySummarizeResponseSchema, UpdateMemorySummarizeRequestSchema } from '../schemas/memorySummarize';
import { OpenApiTag } from './openapiTags';

export const getMemorySummarizeRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the turn-summarization setting',
  description:
    'The stored override for turn summarization, or the `MEMORY_SUMMARIZE` env default when none is stored, plus the effective state with the markdown-only gate applied.',
  'x-fern-sdk-group-name': ['settings', 'memorySummarize'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemorySummarizeResponseSchema } },
      description: 'The stored turn-summarization setting.',
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

export const putMemorySummarizeRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the turn-summarization override',
  description:
    'Persists the turn-summarization override: `true`/`false` turns summarization on/off; `null` clears the override back to the `MEMORY_SUMMARIZE` env default. The response carries the effective state.',
  'x-fern-sdk-group-name': ['settings', 'memorySummarize'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemorySummarizeRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemorySummarizeResponseSchema } },
      description: 'The stored turn-summarization setting after the update.',
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
