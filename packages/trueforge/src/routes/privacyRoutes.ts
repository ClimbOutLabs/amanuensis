import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  ListDataLocationsResponseSchema,
  ListOutboundEventsRequestQuerySchema,
  ListOutboundEventsResponseSchema,
} from '../schemas/privacy';
import { OpenApiTag } from './openapiTags';

const adminErrors = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
  403: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the caller is authenticated but not an admin.',
  },
};

export const listOutboundEventsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'List what left this computer in the last 24 hours',
  description:
    'Returns requests sent to outside services in the last 24 hours, newest first: model requests, emails, web searches, map lookups and connector calls. Hosts and sizes only, never request text.',
  'x-fern-sdk-group-name': ['settings', 'outboundEvents'],
  'x-fern-sdk-method-name': 'list',
  request: { query: ListOutboundEventsRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListOutboundEventsResponseSchema } },
      description: 'Requests in the window.',
    },
    ...adminErrors,
  },
});

export const listDataLocationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'List where Aman keeps data on this computer',
  description:
    'Returns each kind of data Aman keeps (chats, memory, personas, files from runs, settings, backups) with its real location on this computer and its size when measured.',
  'x-fern-sdk-group-name': ['settings', 'dataLocations'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListDataLocationsResponseSchema } },
      description: 'One entry per kind of data.',
    },
    ...adminErrors,
  },
});
