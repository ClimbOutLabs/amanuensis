import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreatePersonaRequestSchema,
  DeletePersonaResponseSchema,
  GetPersonaContextResponseSchema,
  GetPersonaResponseSchema,
  GetSessionPersonaResponseSchema,
  ListPersonaActivationsResponseSchema,
  ListPersonasResponseSchema,
  PersonaIdParamsSchema,
  SetSessionPersonaRequestSchema,
  UpdatePersonaRequestSchema,
} from '../schemas/persona';
import { SessionIdParamsSchema } from '../schemas/session';
import { OpenApiTag } from './openapiTags';

const protectedResponses = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

const conflictResponse = {
  409: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'Another persona is already invoked by one of these names.',
  },
};

const notFoundResponse = {
  404: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'No such persona for this user.',
  },
};

const unavailableModelResponse = {
  422: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'The persona model is not currently available from any configured provider.',
  },
};

export const listPersonasRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.PERSONAS],
  summary: 'List personas',
  description: 'Returns the authenticated user’s configured personas, ordered by display name.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: { content: { 'application/json': { schema: ListPersonasResponseSchema } }, description: 'Personas.' },
    ...protectedResponses,
  },
});

export const createPersonaRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Create a persona',
  description:
    'Creates a persona bound to a fully qualified model name. Names and aliases must be unique across the user’s personas, because an ambiguous invocation has no correct answer.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'create',
  request: { body: { content: { 'application/json': { schema: CreatePersonaRequestSchema } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: GetPersonaResponseSchema } }, description: 'Created persona.' },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid persona, including duplicate names or aliases in the submitted persona.',
    },
    ...unavailableModelResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const updatePersonaRoute = createRoute({
  method: 'put',
  path: '/{persona_id}',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Replace a persona',
  description: 'Replaces a persona’s identity, role, and model binding.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: PersonaIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdatePersonaRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: GetPersonaResponseSchema } }, description: 'Updated persona.' },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid persona, including duplicate names or aliases in the submitted persona.',
    },
    ...unavailableModelResponse,
    ...notFoundResponse,
    ...conflictResponse,
    ...protectedResponses,
  },
});

export const deletePersonaRoute = createRoute({
  method: 'delete',
  path: '/{persona_id}',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Delete a persona',
  description:
    'Removes a persona. Recorded activations are kept, so a past turn can still say which persona and model were selected for it.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: PersonaIdParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: DeletePersonaResponseSchema } }, description: 'Persona removed.' },
    ...protectedResponses,
  },
});

export const getPersonaContextRoute = createRoute({
  method: 'get',
  path: '/{persona_id}/context',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Get exact persona context',
  description: 'Returns the exact root-thread-only persona text supplied to the model when this persona is active.',
  'x-fern-sdk-group-name': ['personas'],
  'x-fern-sdk-method-name': 'get_context',
  request: { params: PersonaIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetPersonaContextResponseSchema } },
      description: 'Visible model context.',
    },
    ...notFoundResponse,
    ...protectedResponses,
  },
});

export const getSessionPersonaRoute = createRoute({
  method: 'get',
  path: '/{session_id}/persona',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Get the active persona for a chat',
  description:
    'Returns the most recent persona decision for this chat, or null when it never left the default assistant.',
  'x-fern-sdk-group-name': ['session-personas'],
  'x-fern-sdk-method-name': 'get',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionPersonaResponseSchema } },
      description: 'Active persona.',
    },
    403: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Not the creator.' },
    404: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'No such session.' },
    ...protectedResponses,
  },
});

export const setSessionPersonaRoute = createRoute({
  method: 'put',
  path: '/{session_id}/persona',
  tags: [OpenApiTag.PERSONAS],
  summary: 'Activate a persona for a chat, or return to the default assistant',
  description:
    'Records an explicit persona decision for this chat. `persona_id: null` returns to the default assistant. The chat’s own model setting is never changed.',
  'x-fern-sdk-group-name': ['session-personas'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    params: SessionIdParamsSchema,
    body: { content: { 'application/json': { schema: SetSessionPersonaRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSessionPersonaResponseSchema } },
      description: 'Recorded decision.',
    },
    403: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Not the creator.' },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No such session or persona.',
    },
    ...protectedResponses,
  },
});

export const listSessionPersonaActivationsRoute = createRoute({
  method: 'get',
  path: '/{session_id}/persona-activations',
  tags: [OpenApiTag.PERSONAS],
  summary: 'List persona decisions for a chat',
  description:
    'Newest-first log of which persona was selected for this chat and why. Entries carrying a `turn_id` are that turn’s selection provenance.',
  'x-fern-sdk-group-name': ['session-personas'],
  'x-fern-sdk-method-name': 'list_activations',
  request: { params: SessionIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListPersonaActivationsResponseSchema } },
      description: 'Persona decisions.',
    },
    403: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Not the creator.' },
    404: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'No such session.' },
    ...protectedResponses,
  },
});
