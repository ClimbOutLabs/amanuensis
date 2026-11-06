/** Maps server address routes (mounted at /api/v1/settings/maps). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetMapsSettingsResponseSchema,
  TestMapsSettingsResponseSchema,
  UpdateMapsSettingsRequestSchema,
} from '../schemas/mapsSettings';
import { OpenApiTag } from './openapiTags';

export const getMapsSettingsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Get the maps server addresses',
  description:
    'Every maps server field as the Settings card shows it: the environment address when the environment sets one, else the saved address, plus the built-in default.',
  'x-fern-sdk-group-name': ['settings', 'maps'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetMapsSettingsResponseSchema } },
      description: 'The maps server fields.',
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

export const putMapsSettingsRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Save or clear maps server addresses',
  description:
    'Saves the given maps server addresses in Settings. A field sent as null is cleared back to its default; a field left out keeps its saved address. An address set by the environment still wins.',
  'x-fern-sdk-group-name': ['settings', 'maps'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateMapsSettingsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetMapsSettingsResponseSchema } },
      description: 'The maps server fields after the update.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'A maps server address cannot be saved; the error says what to fix.',
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

export const testMapsSettingsRoute = createRoute({
  method: 'post',
  path: '/test',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Test the maps server addresses',
  description:
    'Tries each maps server address in force once: a short route from the route servers, one address lookup, one journey plan, and one map tile. Each service is reported on its own.',
  'x-fern-sdk-group-name': ['settings', 'maps'],
  'x-fern-sdk-method-name': 'test',
  responses: {
    200: {
      content: { 'application/json': { schema: TestMapsSettingsResponseSchema } },
      description: 'One result per maps service.',
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
