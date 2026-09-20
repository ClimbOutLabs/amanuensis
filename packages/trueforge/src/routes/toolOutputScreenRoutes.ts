/** Live tool-output screen setting routes (mounted at /api/v1/settings/tool-output-screens). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetToolOutputScreenResponseSchema, UpdateToolOutputScreenRequestSchema } from '../schemas/toolOutputScreen';
import { OpenApiTag } from './openapiTags';

export const getToolOutputScreenRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the live tool-output screen setting',
  description:
    'The persisted override for the live tool-output screen, or the `TOOL_OUTPUT_SCREEN_ENABLED` env default when none is stored.',
  'x-fern-sdk-group-name': ['settings', 'toolOutputScreens'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetToolOutputScreenResponseSchema } },
      description: 'The stored tool-output screen setting.',
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

export const putToolOutputScreenRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Create, replace, or clear the tool-output screen override',
  description:
    'Persists the live tool-output screen override: `true`/`false` turns screening on/off; `null` clears the override back to the `TOOL_OUTPUT_SCREEN_ENABLED` env default. `true`/`false` is rejected with 409 while no screening service is configured (`MEMORY_SCREEN_URL` unset); `null` is always allowed.',
  'x-fern-sdk-group-name': ['settings', 'toolOutputScreens'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateToolOutputScreenRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetToolOutputScreenResponseSchema } },
      description: 'The stored tool-output screen setting after the update.',
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
        'Screening service not configured (`MEMORY_SCREEN_URL` unset): `enabled` `true`/`false` is rejected; `null` (clear) is still allowed.',
    },
  },
});
