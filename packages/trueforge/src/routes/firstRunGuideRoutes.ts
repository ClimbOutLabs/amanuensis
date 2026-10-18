/** First-run checklist routes (mounted at /api/v1/settings/first-run-guide). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetFirstRunGuideResponseSchema, UpdateFirstRunGuideRequestSchema } from '../schemas/firstRunGuide';
import { OpenApiTag } from './openapiTags';

export const getFirstRunGuideRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the first-run checklist state',
  description: 'Whether the owner has dismissed the first-run checklist. Not dismissed until the owner says so.',
  'x-fern-sdk-group-name': ['settings', 'firstRunGuide'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetFirstRunGuideResponseSchema } },
      description: 'The first-run checklist state.',
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

export const putFirstRunGuideRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Dismiss or restore the first-run checklist',
  description: 'Persists whether the first-run checklist is dismissed. The response carries the stored state.',
  'x-fern-sdk-group-name': ['settings', 'firstRunGuide'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateFirstRunGuideRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetFirstRunGuideResponseSchema } },
      description: 'The first-run checklist state after the update.',
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
