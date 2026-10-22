import { createRoute } from '@hono/zod-openapi';
import {
  BriefItemKeyParamSchema,
  DeleteBriefItemDoneResponseSchema,
  ListBriefItemCompletionsRequestQuerySchema,
  ListBriefItemCompletionsResponseSchema,
  MarkBriefItemDoneRequestSchema,
  MarkBriefItemDoneResponseSchema,
} from '../schemas/briefItems';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

const unauthorizedResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'OIDC is configured and the request has no valid session cookie.',
};

export const markBriefItemDoneRoute = createRoute({
  method: 'post',
  path: '/completions',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Mark a morning brief item done',
  description:
    'Marks one morning brief item done for the authenticated user, so it is left out of later briefs. Marking it again refreshes the time.',
  'x-fern-sdk-group-name': ['personalization', 'briefItems'],
  'x-fern-sdk-method-name': 'markDone',
  request: {
    body: { content: { 'application/json': { schema: MarkBriefItemDoneRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: MarkBriefItemDoneResponseSchema } },
      description: 'The item as marked done.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: unauthorizedResponse,
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The chat was not found.',
    },
  },
});

export const undoBriefItemDoneRoute = createRoute({
  method: 'delete',
  path: '/completions/{item_key}',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Undo a morning brief item marked done',
  description:
    'Puts a morning brief item back on the list for the authenticated user. Undoing an item that is not done is not an error.',
  'x-fern-sdk-group-name': ['personalization', 'briefItems'],
  'x-fern-sdk-method-name': 'undo',
  request: { params: BriefItemKeyParamSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteBriefItemDoneResponseSchema } },
      description: 'The item is no longer marked done.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid item key.',
    },
    401: unauthorizedResponse,
  },
});

export const listBriefItemCompletionsRoute = createRoute({
  method: 'get',
  path: '/completions',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'List morning brief items marked done',
  description:
    'Lists the morning brief items the authenticated user marked done since a time, newest first. Defaults to the last seven days.',
  'x-fern-sdk-group-name': ['personalization', 'briefItems'],
  'x-fern-sdk-method-name': 'list',
  request: { query: ListBriefItemCompletionsRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListBriefItemCompletionsResponseSchema } },
      description: 'Completed brief items.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters.',
    },
    401: unauthorizedResponse,
  },
});
