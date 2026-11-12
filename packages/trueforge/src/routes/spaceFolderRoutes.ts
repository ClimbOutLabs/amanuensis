import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { SpaceIdParamsSchema } from '../schemas/space';
import {
  CreateSpaceFolderRequestSchema,
  DeleteSpaceFolderResponseSchema,
  GetSpaceFolderResponseSchema,
  ListSpaceFoldersResponseSchema,
  SetSpaceFolderRequestSchema,
  SetSpaceFolderResponseSchema,
  SpaceFolderIdParamsSchema,
  UpdateSpaceFolderRequestSchema,
} from '../schemas/spaceFolder';
import { OpenApiTag } from './openapiTags';

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description,
});

export const listSpaceFoldersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SPACES],
  summary: 'List space folders',
  'x-fern-sdk-group-name': ['space-folders'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListSpaceFoldersResponseSchema } },
      description: "The authenticated user's space folders, ordered by name.",
    },
  },
});

export const createSpaceFolderRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.SPACES],
  summary: 'Create a space folder',
  'x-fern-sdk-group-name': ['space-folders'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateSpaceFolderRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetSpaceFolderResponseSchema } },
      description: 'The created folder.',
    },
    400: errorResponse('Invalid folder name.'),
  },
});

export const putSpaceFolderRoute = createRoute({
  method: 'put',
  path: '/{folder_id}',
  tags: [OpenApiTag.SPACES],
  summary: 'Rename a space folder',
  'x-fern-sdk-group-name': ['space-folders'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: SpaceFolderIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateSpaceFolderRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSpaceFolderResponseSchema } },
      description: 'The renamed folder.',
    },
    400: errorResponse('Invalid folder name.'),
    404: errorResponse('Folder not found for this user.'),
  },
});

export const deleteSpaceFolderRoute = createRoute({
  method: 'delete',
  path: '/{folder_id}',
  tags: [OpenApiTag.SPACES],
  summary: 'Delete a space folder',
  description: 'Deletes the folder and leaves its spaces without a folder.',
  'x-fern-sdk-group-name': ['space-folders'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: SpaceFolderIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSpaceFolderResponseSchema } },
      description: 'Folder deleted or already absent.',
    },
  },
});

export const setSpaceFolderRoute = createRoute({
  method: 'put',
  path: '/{space_id}/folder',
  tags: [OpenApiTag.SPACES],
  summary: 'Move a space into a folder',
  description: 'Placement is not an edit: the space revision and timestamps stay as they were.',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'set_folder',
  request: {
    params: SpaceIdParamsSchema,
    body: { content: { 'application/json': { schema: SetSpaceFolderRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SetSpaceFolderResponseSchema } },
      description: 'Space moved.',
    },
    404: errorResponse('Space or folder not found for this user.'),
  },
});

export const clearSpaceFolderRoute = createRoute({
  method: 'delete',
  path: '/{space_id}/folder',
  tags: [OpenApiTag.SPACES],
  summary: 'Take a space out of its folder',
  'x-fern-sdk-group-name': ['spaces'],
  'x-fern-sdk-method-name': 'clear_folder',
  request: { params: SpaceIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SetSpaceFolderResponseSchema } },
      description: 'Space is no longer in a folder.',
    },
    404: errorResponse('Space not found for this user.'),
  },
});
