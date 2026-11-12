/** Page-sorting setting routes (mounted at /api/v1/settings/memory-page-sorting). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetMemoryPageSortingResponseSchema, UpdateMemoryPageSortingRequestSchema } from '../schemas/memoryPageSorting';
import { OpenApiTag } from './openapiTags';

export const getMemoryPageSortingRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the page-sorting setting',
  description:
    'How saved notes are sorted onto pages: the stored override, or the `MEMORY_PAGE_SORTING` env default when none is stored.',
  'x-fern-sdk-group-name': ['settings', 'memoryPageSorting'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageSortingResponseSchema } },
      description: 'The stored page-sorting setting.',
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

export const putMemoryPageSortingRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the page-sorting override',
  description:
    'Persists the page-sorting override: `off`, `report` (only note what it would do) or `on`; `null` clears it back to the `MEMORY_PAGE_SORTING` env default.',
  'x-fern-sdk-group-name': ['settings', 'memoryPageSorting'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryPageSortingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryPageSortingResponseSchema } },
      description: 'The stored page-sorting setting after the update.',
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
