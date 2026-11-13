/** Nightly tidy-up setting routes (mounted at /api/v1/settings/memory-nightly). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetMemoryNightlyResponseSchema,
  RunMemoryNightlyResponseSchema,
  UpdateMemoryNightlyRequestSchema,
} from '../schemas/memoryNightly';
import { OpenApiTag } from './openapiTags';

export const getMemoryNightlyRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the nightly tidy-up setting',
  description:
    'Whether the nightly tidy-up runs and at which hour: the stored override, or the `MEMORY_NIGHTLY_JOB` env default when none is stored.',
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
    'Persists the nightly tidy-up override and its hour: `true` or `false` turns it on or off; `null` clears it back to the `MEMORY_NIGHTLY_JOB` env default. A field left out stays as it is.',
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

export const runMemoryNightlyRoute = createRoute({
  method: 'post',
  path: '/run',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Run the tidy-up now',
  description:
    'Tidies the memory pages now, whatever the hour and whether or not the daily tidy-up is on. Answers when it has finished, with what it did.',
  'x-fern-sdk-group-name': ['settings', 'memoryNightly'],
  'x-fern-sdk-method-name': 'run',
  responses: {
    200: {
      content: { 'application/json': { schema: RunMemoryNightlyResponseSchema } },
      description: 'What the tidy-up did, or that one was already running.',
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

export const getMemoryNightlyRunRoute = createRoute({
  method: 'get',
  path: '/run',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'See where a tidy-up stands',
  description:
    'Tells whether a tidy-up is running now (`busy`), what one that finished in the last hour did (`ran`), or that there is neither (`idle`). It starts nothing.',
  'x-fern-sdk-group-name': ['settings', 'memoryNightly'],
  'x-fern-sdk-method-name': 'get_run',
  responses: {
    200: {
      content: { 'application/json': { schema: RunMemoryNightlyResponseSchema } },
      description: 'Where a tidy-up stands.',
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
