/** Recall screen setting routes (mounted at /api/v1/settings/memory-screens). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetMemoryScreenResponseSchema, UpdateMemoryScreenRequestSchema } from '../schemas/memoryScreen';
import { OpenApiTag } from './openapiTags';

export const getMemoryScreenRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the recall screen setting',
  description:
    'The persisted override for the recall screen, or the `MEMORY_SCREEN_ENABLED` env default when none is stored.',
  'x-fern-sdk-group-name': ['settings', 'memoryScreens'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryScreenResponseSchema } },
      description: 'The stored recall screen setting.',
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

export const putMemoryScreenRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the recall screen override',
  description:
    'Persists the recall screen override. `true`/`false` turns recall screening on/off; `null` clears back to the `MEMORY_SCREEN_ENABLED` env default. `true` is rejected with 409 while `MEMORY_SCREEN_URL` is unset; `false` and `null` are always allowed.',
  'x-fern-sdk-group-name': ['settings', 'memoryScreens'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryScreenRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryScreenResponseSchema } },
      description: 'The stored recall screen setting after the update.',
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
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description:
        'Screening service not configured (`MEMORY_SCREEN_URL` unset): `enabled` `true` is rejected; `false` and `null` (clear) are still allowed.',
    },
  },
});
