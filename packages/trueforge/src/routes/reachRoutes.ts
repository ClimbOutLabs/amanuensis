import { createRoute } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetReachResponseSchema,
  ListReachSuggestionsResponseSchema,
  RunNoticingRequestSchema,
  RunNoticingResponseSchema,
  TestReachChannelRequestSchema,
  TestReachChannelResponseSchema,
  UpdateReachRequestSchema,
} from '../schemas/reach';
import { OpenApiTag } from './openapiTags';

const unauthorizedResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'OIDC is configured and the request has no valid session cookie.',
};

const invalidRequestResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Invalid request.',
};

export const getReachRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Get Reach me settings',
  description: 'Reads how the signed-in person wants to be reached, with which channels are set up on this server.',
  'x-fern-sdk-group-name': ['reach'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: { content: { 'application/json': { schema: GetReachResponseSchema } }, description: 'The settings.' },
    401: unauthorizedResponse,
  },
});

export const updateReachRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Save Reach me settings',
  description:
    'Replaces how the signed-in person wants to be reached. Texts and calls cannot be turned on until set up.',
  'x-fern-sdk-group-name': ['reach'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: { body: { content: { 'application/json': { schema: UpdateReachRequestSchema } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: GetReachResponseSchema } }, description: 'The saved settings.' },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});

export const listReachSuggestionsRoute = createRoute({
  method: 'get',
  path: '/suggestions',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'List always-important suggestions',
  description: 'Lists senders the memory suggests. Nothing is added until the person accepts it in a saved update.',
  'x-fern-sdk-group-name': ['reach'],
  'x-fern-sdk-method-name': 'list_suggestions',
  responses: {
    200: {
      content: { 'application/json': { schema: ListReachSuggestionsResponseSchema } },
      description: 'The suggestions.',
    },
    401: unauthorizedResponse,
  },
});

export const testReachChannelRoute = createRoute({
  method: 'post',
  path: '/test',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Try a channel',
  description: 'Sends the signed-in person a test item on one channel. A channel that is not set up answers 409.',
  'x-fern-sdk-group-name': ['reach'],
  'x-fern-sdk-method-name': 'test_channel',
  request: { body: { content: { 'application/json': { schema: TestReachChannelRequestSchema } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: TestReachChannelResponseSchema } }, description: 'The test item.' },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'That channel is not set up yet.',
    },
  },
});

export const runNoticingRoute = createRoute({
  method: 'post',
  path: '/run',
  tags: [OpenApiTag.INTERNAL],
  summary: 'Run a noticing pass',
  description: 'Runs one pass of one watcher for everyone it can watch.',
  'x-fern-sdk-group-name': ['internal', 'noticing'],
  'x-fern-sdk-method-name': 'run',
  request: { body: { content: { 'application/json': { schema: RunNoticingRequestSchema } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: RunNoticingResponseSchema } }, description: 'The pass finished.' },
    400: invalidRequestResponse,
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid service credential.',
    },
  },
});
