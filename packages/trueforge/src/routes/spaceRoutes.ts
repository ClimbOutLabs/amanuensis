import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateSpaceRequestSchema,
  CreateSpaceResponseSchema,
  DeleteSpaceRequestQuerySchema,
  GetSpaceResponseSchema,
  ListSpacesQuerySchema,
  ListSpacesResponseSchema,
  SpaceIdParamsSchema,
  UpdateSpaceRequestSchema,
  UpdateSpaceResponseSchema,
} from '../schemas/space';
import { OpenApiTag } from './openapiTags';

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description,
});
const protectedResponse = errorResponse('OIDC is configured and the request has no valid session cookie.');
const staleResponse = errorResponse('The supplied entity or aggregate revision is stale.');

export const listSpacesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SPACES],
  summary: 'List spaces',
  description: 'Returns the authenticated user’s spaces, ordered by name.',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'list',
  request: { query: ListSpacesQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: ListSpacesResponseSchema } }, description: 'Spaces.' },
    409: staleResponse,
    401: protectedResponse,
  },
});

export const createSpaceRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.SPACES],
  summary: 'Create a space',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'create',
  request: { body: { content: { 'application/json': { schema: CreateSpaceRequestSchema } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: CreateSpaceResponseSchema } }, description: 'Created space.' },
    400: errorResponse('Invalid request.'),
    409: staleResponse,
    401: protectedResponse,
  },
});

export const getSpaceRoute = createRoute({
  method: 'get',
  path: '/{space_id}',
  tags: [OpenApiTag.SPACES],
  summary: 'Get a space',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'get',
  request: { params: SpaceIdParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetSpaceResponseSchema } }, description: 'Space.' },
    404: errorResponse('Space not found.'),
    401: protectedResponse,
  },
});

export const updateSpaceRoute = createRoute({
  method: 'put',
  path: '/{space_id}',
  tags: [OpenApiTag.SPACES],
  summary: 'Replace a space',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: SpaceIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateSpaceRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: UpdateSpaceResponseSchema } }, description: 'Updated space.' },
    400: errorResponse('Invalid request.'),
    404: errorResponse('Space not found.'),
    409: staleResponse,
    401: protectedResponse,
  },
});

export const deleteSpaceRoute = createRoute({
  method: 'delete',
  path: '/{space_id}',
  tags: [OpenApiTag.SPACES],
  summary: 'Delete a space',
  description:
    'Deletes a space. No tool exposes this to the model; only a person acting through the UI can delete a space.',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: SpaceIdParamsSchema, query: DeleteSpaceRequestQuerySchema },
  responses: {
    204: { description: 'Space deleted.' },
    404: errorResponse('Space not found.'),
    409: staleResponse,
    401: protectedResponse,
  },
});
