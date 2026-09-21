import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  DeletePersonalizationProfileResponseSchema,
  GetPersonalizationContextResponseSchema,
  GetPersonalizationProfileResponseSchema,
  UpdatePersonalizationProfileRequestSchema,
} from '../schemas/personalization';
import { OpenApiTag } from './openapiTags';

const protectedResponses = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

export const getPersonalizationProfileRoute = createRoute({
  method: 'get',
  path: '/profile',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get personalization profile',
  description: 'Returns the authenticated user’s locally stored assistant and user profile.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'get_profile',
  responses: {
    200: {
      content: { 'application/json': { schema: GetPersonalizationProfileResponseSchema } },
      description: 'Profile.',
    },
    ...protectedResponses,
  },
});

export const updatePersonalizationProfileRoute = createRoute({
  method: 'put',
  path: '/profile',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Create or update personalization profile',
  description:
    'Replaces the authenticated user’s profile and advances its revision only when model-relevant content changes.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'create_or_update_profile',
  request: {
    body: { content: { 'application/json': { schema: UpdatePersonalizationProfileRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetPersonalizationProfileResponseSchema } },
      description: 'Saved profile.',
    },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid profile.' },
    ...protectedResponses,
  },
});

export const deletePersonalizationProfileRoute = createRoute({
  method: 'delete',
  path: '/profile',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Delete personalization profile',
  description: 'Removes only the authenticated user’s profile. Conversation records remain unchanged.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'delete_profile',
  responses: {
    200: {
      content: { 'application/json': { schema: DeletePersonalizationProfileResponseSchema } },
      description: 'Profile removed.',
    },
    ...protectedResponses,
  },
});

export const getPersonalizationContextRoute = createRoute({
  method: 'get',
  path: '/context',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get exact personalization context',
  description: 'Returns the exact root-thread-only personalization text supplied to the model for the current profile.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'get_context',
  responses: {
    200: {
      content: { 'application/json': { schema: GetPersonalizationContextResponseSchema } },
      description: 'Visible model context.',
    },
    ...protectedResponses,
  },
});
