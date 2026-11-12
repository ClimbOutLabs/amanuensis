/** Nightly tidy-up setting routes (mounted at /api/v1/settings/memory-nightly). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetMemoryNightlyResponseSchema, UpdateMemoryNightlyRequestSchema } from '../schemas/memoryNightly';
import { OpenApiTag } from './openapiTags';

export const getMemoryNightlyRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the nightly tidy-up setting',
  description:
    'Whether the nightly tidy-up runs: the stored override, or the `MEMORY_NIGHTLY_JOB` env default when none is stored.',
  'x-fern-sdk-group-name': ['settings', 'memoryNightly'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryNightlyResponseSchema } },
      description: 'The stored nightly tidy-up setting.',
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

export const putMemoryNightlyRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the nightly tidy-up override',
  description:
    'Persists the nightly tidy-up override: `true` or `false` turns it on or off; `null` clears it back to the `MEMORY_NIGHTLY_JOB` env default.',
  'x-fern-sdk-group-name': ['settings', 'memoryNightly'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryNightlyRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryNightlyResponseSchema } },
      description: 'The stored nightly tidy-up setting after the update.',
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
