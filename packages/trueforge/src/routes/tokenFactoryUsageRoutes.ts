/** Token Factory daily usage route (mounted at /api/v1/settings/token-factory-usage). */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetTokenFactoryUsageResponseSchema } from '../schemas/tokenFactoryUsage';
import { OpenApiTag } from './openapiTags';

export const getTokenFactoryUsageRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.CAPABILITIES],
  summary: "Get today's Token Factory usage",
  description:
    'Tokens and cost per model counted today (UTC), and the daily cap with what is left under it. Counts come from the usage the provider reported.',
  'x-fern-sdk-group-name': ['settings', 'tokenFactoryUsage'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetTokenFactoryUsageResponseSchema } },
      description: "Today's Token Factory usage.",
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Admin access required.',
    },
  },
});
