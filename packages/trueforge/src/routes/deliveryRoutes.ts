import { createRoute } from '@hono/zod-openapi';
import {
  CreatePushSubscriptionRequestSchema,
  DeletePushSubscriptionRequestQuerySchema,
  DeletePushSubscriptionResponseSchema,
  DeliveriesPageQuerySchema,
  DeliveryIdParamSchema,
  GetDeliveryResponseSchema,
  GetDeliveryUnreadCountResponseSchema,
  GetPushConfigResponseSchema,
  GetPushSubscriptionResponseSchema,
  ListDeliveriesResponseSchema,
  MarkDeliveriesSeenRequestSchema,
} from '../schemas/deliveries';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

const unauthorizedResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'OIDC is configured and the request has no valid session cookie.',
};

const invalidRequestResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Invalid request.',
};

export const listDeliveriesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'List deliveries',
  description: 'Lists what was sent to the signed-in person, newest first, a page at a time.',
  'x-fern-sdk-group-name': ['deliveries'],
  'x-fern-sdk-method-name': 'list',
  request: { query: DeliveriesPageQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListDeliveriesResponseSchema } },
      description: 'One page of deliveries.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});

export const getDeliveryUnreadCountRoute = createRoute({
  method: 'get',
  path: '/unread-count',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Count unread deliveries',
  description: 'Counts deliveries the signed-in person has not seen on any device.',
  'x-fern-sdk-group-name': ['deliveries'],
  'x-fern-sdk-method-name': 'get_unread_count',
  responses: {
    200: {
      content: { 'application/json': { schema: GetDeliveryUnreadCountResponseSchema } },
      description: 'The unread count.',
    },
    401: unauthorizedResponse,
  },
});

export const markDeliveriesSeenRoute = createRoute({
  method: 'post',
  path: '/seen',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Mark deliveries seen',
  description: 'Marks deliveries seen for the signed-in person on every device. Ids that are not theirs are ignored.',
  'x-fern-sdk-group-name': ['deliveries'],
  'x-fern-sdk-method-name': 'mark_seen',
  request: {
    body: { content: { 'application/json': { schema: MarkDeliveriesSeenRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetDeliveryUnreadCountResponseSchema } },
      description: 'The unread count after marking.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});

export const getDeliveryRoute = createRoute({
  method: 'get',
  path: '/{delivery_id}',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Get a delivery',
  description: 'Reads one delivery of the signed-in person.',
  'x-fern-sdk-group-name': ['deliveries'],
  'x-fern-sdk-method-name': 'get',
  request: { params: DeliveryIdParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetDeliveryResponseSchema } }, description: 'The delivery.' },
    401: unauthorizedResponse,
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The delivery was not found.',
    },
  },
});

export const getPushConfigRoute = createRoute({
  method: 'get',
  path: '/config',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Get the push settings',
  description: 'Returns the public key a browser needs to turn notices on, or null when push is off.',
  'x-fern-sdk-group-name': ['deliveries', 'push'],
  'x-fern-sdk-method-name': 'get_config',
  responses: {
    200: {
      content: { 'application/json': { schema: GetPushConfigResponseSchema } },
      description: 'The push settings.',
    },
    401: unauthorizedResponse,
  },
});

export const createPushSubscriptionRoute = createRoute({
  method: 'post',
  path: '/subscriptions',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Turn notices on for a device',
  description: 'Saves a device so due reminders and nudges reach it. Saving the same device again changes nothing.',
  'x-fern-sdk-group-name': ['deliveries', 'push'],
  'x-fern-sdk-method-name': 'create_subscription',
  request: {
    body: { content: { 'application/json': { schema: CreatePushSubscriptionRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetPushSubscriptionResponseSchema } },
      description: 'The saved device.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});

export const deletePushSubscriptionRoute = createRoute({
  method: 'delete',
  path: '/subscriptions',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Turn notices off for a device',
  description: 'Removes a device. Removing one that is not saved is not an error.',
  'x-fern-sdk-group-name': ['deliveries', 'push'],
  'x-fern-sdk-method-name': 'delete_subscription',
  request: { query: DeletePushSubscriptionRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeletePushSubscriptionResponseSchema } },
      description: 'The device no longer gets notices.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});
