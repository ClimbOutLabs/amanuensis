import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetNotesFolderResponseSchema,
  RemoveNotesFolderResponseSchema,
  SaveNotesFolderRequestSchema,
  SaveNotesFolderResponseSchema,
} from '../schemas/notesFolder';
import { OpenApiTag } from './openapiTags';

const unauthorized = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

const refused = {
  403: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The caller is not an admin, or the request did not come from this app, so nothing was done.',
  },
};

/** The three routes of the Notes folder card: status, connect and remove, under the user settings. */
export const notesFolderRoutes = {
  status: createRoute({
    method: 'get',
    path: '/status',
    tags: [OpenApiTag.PERSONALIZATION],
    summary: 'Get the notes folder status',
    description:
      'Returns whether a notes folder is connected, the folder, the inbox file name, and how many notes the folder holds.',
    'x-fern-sdk-group-name': ['settings', 'notes'],
    'x-fern-sdk-method-name': 'get_status',
    responses: {
      200: {
        content: { 'application/json': { schema: GetNotesFolderResponseSchema } },
        description: 'The notes folder status.',
      },
      ...unauthorized,
      ...refused,
    },
  }),
  save: createRoute({
    method: 'post',
    path: '/',
    tags: [OpenApiTag.PERSONALIZATION],
    summary: 'Connect a notes folder',
    description:
      'Checks the folder first and saves it only when it can be used: it must be there, be a folder, and not be where Aman keeps its own memory.',
    'x-fern-sdk-group-name': ['settings', 'notes'],
    'x-fern-sdk-method-name': 'save_folder',
    request: {
      body: { content: { 'application/json': { schema: SaveNotesFolderRequestSchema } }, required: true },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: SaveNotesFolderResponseSchema } },
        description: 'The folder is connected.',
      },
      400: {
        content: { 'application/json': { schema: RequestErrorResponseSchema } },
        description: 'The folder could not be used, and the message says what to pick instead.',
      },
      ...unauthorized,
      ...refused,
    },
  }),
  remove: createRoute({
    method: 'delete',
    path: '/',
    tags: [OpenApiTag.PERSONALIZATION],
    summary: 'Remove the notes folder',
    description: 'Forgets the folder. Nothing inside the folder is changed or removed.',
    'x-fern-sdk-group-name': ['settings', 'notes'],
    'x-fern-sdk-method-name': 'remove_folder',
    responses: {
      200: {
        content: { 'application/json': { schema: RemoveNotesFolderResponseSchema } },
        description: 'The folder is disconnected.',
      },
      ...unauthorized,
      ...refused,
    },
  }),
};
