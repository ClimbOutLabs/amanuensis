/** Item-tracking setting routes (mounted at /api/v1/settings/memory-item-tracking). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetMemoryItemTrackingResponseSchema,
  UpdateMemoryItemTrackingRequestSchema,
} from '../schemas/memoryItemTracking';
import { OpenApiTag } from './openapiTags';

export const getMemoryItemTrackingRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the item-tracking setting',
  description: 'The stored override for item tracking, or the default (on) when none is stored.',
  'x-fern-sdk-group-name': ['settings', 'memoryItemTracking'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryItemTrackingResponseSchema } },
      description: 'The stored item-tracking setting.',
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

export const putMemoryItemTrackingRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the item-tracking override',
  description:
    'Persists the item-tracking override: `true`/`false` turns tracking of open items on/off; `null` clears the override back to the default. Turning it off leaves the diary and the items already recorded untouched.',
  'x-fern-sdk-group-name': ['settings', 'memoryItemTracking'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMemoryItemTrackingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMemoryItemTrackingResponseSchema } },
      description: 'The stored item-tracking setting after the update.',
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
