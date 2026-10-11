import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  GetSentinelUserSettingsResponseSchema,
  UpdateSentinelUserSettingsRequestSchema,
} from '../schemas/sentinelSettings';
import { OpenApiTag } from './openapiTags';

const unauthorized = {
  401: {
    content: { 'application/json': { schema: RequestErrorResponseSchema } },
    description: 'OIDC is configured and the request has no valid session cookie.',
  },
};

export const getSentinelUserSettingsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Get Sentinel permission settings',
  description: 'Returns the authenticated user’s offline mode and the Tier 2 action kinds that run without asking.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'get_sentinel_settings',
  responses: {
    200: {
      content: { 'application/json': { schema: GetSentinelUserSettingsResponseSchema } },
      description: 'Settings; defaults when nothing was saved.',
    },
    ...unauthorized,
  },
});

export const updateSentinelUserSettingsRoute = createRoute({
  method: 'patch',
  path: '/',
  tags: [OpenApiTag.PERSONALIZATION],
  summary: 'Update Sentinel permission settings',
  description: 'Changes only the provided fields of the authenticated user’s Sentinel settings.',
  'x-fern-sdk-group-name': ['personalization'],
  'x-fern-sdk-method-name': 'update_sentinel_settings',
  request: {
    body: { content: { 'application/json': { schema: UpdateSentinelUserSettingsRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSentinelUserSettingsResponseSchema } },
      description: 'Saved settings.',
    },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid settings.' },
    ...unauthorized,
  },
});
