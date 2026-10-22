import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetHelpHealthCheckResponseSchema } from '../schemas/help';
import { OpenApiTag } from './openapiTags';

export const getHelpHealthCheckRoute = createRoute({
  method: 'get',
  path: '/health-check',
  tags: [OpenApiTag.HELP],
  summary: 'Get the help health check',
  description:
    'Checks the default model, connectors, sandbox and schedules, and the last full check run on the computer. Each check has one plain sentence and, when needed, one next step.',
  'x-fern-sdk-group-name': ['help'],
  'x-fern-sdk-method-name': 'get_health_check',
  responses: {
    200: {
      content: { 'application/json': { schema: GetHelpHealthCheckResponseSchema } },
      description: 'The health check.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
  },
});
