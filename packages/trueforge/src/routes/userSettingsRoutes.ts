import { createRoute } from '@hono/zod-openapi';

import {
  SentinelUserSettingsSchema,
  UpdateSentinelUserSettingsRequestSchema,
} from '../schemas/sentinelUserSettings';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const getSentinelUserSettingsRoute = createRoute({
  method: 'get',
  path: '/settings/sentinel',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Get Sentinel user settings',
  description: 'Get the calling user\u2019s Sentinel settings: Tier 2 "always ask" toggles and offline mode. Returns defaults when unset.',
  'x-fern-sdk-group-name': ['user'],
  'x-fern-sdk-method-name': 'get_sentinel_settings',
  responses: {
    200: {
      content: { 'application/json': { schema: SentinelUserSettingsSchema } },
      description: 'The user\u2019s Sentinel settings.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid Bearer <redacted> or auth cookie',
    },
  },
});

export const updateSentinelUserSettingsRoute = createRoute({
  method: 'patch',
  path: '/settings/sentinel',
  tags: [OpenApiTag.AGENT_SESSIONS],
  summary: 'Update Sentinel user settings',
  description: 'Update the calling user\u2019s Sentinel settings. Only the provided fields are changed.',
  'x-fern-sdk-group-name': ['user'],
  'x-fern-sdk-method-name': 'update_sentinel_settings',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateSentinelUserSettingsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SentinelUserSettingsSchema } },
      description: 'The updated settings.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid Bearer <redacted> or auth cookie',
    },
  },
});
