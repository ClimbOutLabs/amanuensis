import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { SessionIdParamsSchema } from '../schemas/session';
import {
  CreateSessionFolderRequestSchema,
  DeleteSessionFolderResponseSchema,
  GetSessionFolderResponseSchema,
  ListSessionFoldersResponseSchema,
  SessionFolderIdParamsSchema,
  SetSessionFolderRequestSchema,
  SetSessionFolderResponseSchema,
  UpdateSessionFolderRequestSchema,
} from '../schemas/sessionFolder';
import { OpenApiTag } from './openapiTags';

export const listSessionFoldersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'List session folders',
  'x-fern-sdk-group-name': ['session-folders'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListSessionFoldersResponseSchema } },
      description: "The authenticated user's folders.",
    },
  },
});

export const createSessionFolderRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Create a session folder',
  'x-fern-sdk-group-name': ['session-folders'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateSessionFolderRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetSessionFolderResponseSchema } },
      description: 'The created folder.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid folder name.',
    },
  },
});

export const putSessionFolderRoute = createRoute({
  method: 'put',
  path: '/{folder_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Rename a session folder',
  'x-fern-sdk-group-name': ['session-folders'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: SessionFolderIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateSessionFolderRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionFolderResponseSchema } },
      description: 'The renamed folder.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid folder name.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Folder not found for this user.',
    },
  },
});

export const deleteSessionFolderRoute = createRoute({
  method: 'delete',
  path: '/{folder_id}',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Delete a session folder',
  description: 'Deletes the folder and leaves its sessions unassigned.',
  'x-fern-sdk-group-name': ['session-folders'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: SessionFolderIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSessionFolderResponseSchema } },
      description: 'Folder deleted or already absent.',
    },
  },
});

export const setSessionFolderRoute = createRoute({
  method: 'put',
  path: '/{session_id}/folder',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Assign a session to a folder',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'set_folder',
  request: {
    params: SessionIdParamsSchema,
    body: { content: { 'application/json': { schema: SetSessionFolderRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SetSessionFolderResponseSchema } },
      description: 'Folder assigned without changing session activity ordering.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session or owner-scoped folder not found.',
    },
  },
});

export const clearSessionFolderRoute = createRoute({
  method: 'delete',
  path: '/{session_id}/folder',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Unassign a session from its folder',
  'x-fern-sdk-group-name': ['sessions'],
  'x-fern-sdk-method-name': 'clear_folder',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: SetSessionFolderResponseSchema } },
      description: 'Folder unassigned without changing session activity ordering.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Caller is not the session creator.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Session not found.',
    },
  },
});
