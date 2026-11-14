import { createRoute, z } from '@hono/zod-openapi';

import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  AddTextWordRequestSchema,
  ConfirmTextCodeRequestSchema,
  DeleteTextNumberResponseSchema,
  GetTextStatusResponseSchema,
  SendTextCodeRequestSchema,
  UpdateTextModeRequestSchema,
} from '../schemas/textMessages';
import { OpenApiTag } from './openapiTags';

const unauthorizedResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'OIDC is configured and the request has no valid session cookie.',
};

const invalidRequestResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Invalid request.',
};

const notSetUpResponse = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Texts are not set up on this server, or there is no number yet.',
};

export const getTextStatusRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Get text number status',
  description: 'Reads the signed-in person’s number for texts and whether it is confirmed.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: { content: { 'application/json': { schema: GetTextStatusResponseSchema } }, description: 'The status.' },
    401: unauthorizedResponse,
  },
});

export const sendTextCodeRoute = createRoute({
  method: 'post',
  path: '/code',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Send a confirmation code',
  description: 'Texts a one-time code to a number. Nothing else is sent to a number until it is confirmed.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'send_code',
  request: { body: { content: { 'application/json': { schema: SendTextCodeRequestSchema } }, required: true } },
  responses: {
    201: {
      content: { 'application/json': { schema: GetTextStatusResponseSchema } },
      description: 'The code was sent.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
    409: notSetUpResponse,
    429: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Too many codes were sent. Try again later.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The code could not be sent.',
    },
  },
});

export const confirmTextCodeRoute = createRoute({
  method: 'post',
  path: '/confirm',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Confirm a number',
  description: 'Checks the one-time code. A right code confirms the number. Too many wrong tries void the code.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'confirm',
  request: { body: { content: { 'application/json': { schema: ConfirmTextCodeRequestSchema } }, required: true } },
  responses: {
    200: {
      content: { 'application/json': { schema: GetTextStatusResponseSchema } },
      description: 'The number is confirmed.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
  },
});

export const updateTextModeRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Choose what texts say',
  description: 'Chooses Private (only the kind of thing) or Full (a reminder’s own words).',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'update',
  request: { body: { content: { 'application/json': { schema: UpdateTextModeRequestSchema } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: GetTextStatusResponseSchema } }, description: 'The saved choice.' },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
    409: notSetUpResponse,
  },
});

export const deleteTextNumberRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Remove the number',
  description: 'Forgets the number and switches texts off.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'delete',
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteTextNumberResponseSchema } },
      description: 'The number is gone.',
    },
    401: unauthorizedResponse,
  },
});

export const addTextWordRoute = createRoute({
  method: 'post',
  path: '/words',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Add a word Aman may text',
  description:
    'Lets a Full text carry a name or word that is not a common word. Letters only. A web ending or a number word is refused.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'add_word',
  request: { body: { content: { 'application/json': { schema: AddTextWordRequestSchema } }, required: true } },
  responses: {
    201: {
      content: { 'application/json': { schema: GetTextStatusResponseSchema } },
      description: 'The word is added.',
    },
    400: invalidRequestResponse,
    401: unauthorizedResponse,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The person has as many words as are allowed.',
    },
  },
});

export const removeTextWordRoute = createRoute({
  method: 'delete',
  path: '/words/{word}',
  tags: [OpenApiTag.DELIVERIES],
  summary: 'Remove a word Aman may text',
  description: 'Takes a word off the person’s list. A word that is not on it changes nothing.',
  'x-fern-sdk-group-name': ['reach', 'texts'],
  'x-fern-sdk-method-name': 'remove_word',
  request: { params: z.object({ word: z.string().min(1).max(60).describe('The word to remove.') }) },
  responses: {
    200: {
      content: { 'application/json': { schema: GetTextStatusResponseSchema } },
      description: 'The status without the word.',
    },
    401: unauthorizedResponse,
  },
});
