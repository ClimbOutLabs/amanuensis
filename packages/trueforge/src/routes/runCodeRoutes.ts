import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { GetRunCodeStatusResponseSchema } from '../schemas/runCodeStatus';
import { OpenApiTag } from './openapiTags';

export const getRunCodeStatusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Get the code execution sandbox status',
  description:
    'Checks live whether the run_code sandbox can execute code, and if not, why. Runs a short readiness probe, so it can take a few seconds.',
  'x-fern-sdk-group-name': ['settings', 'runCode'],
  'x-fern-sdk-method-name': 'get_status',
  responses: {
    200: {
      content: { 'application/json': { schema: GetRunCodeStatusResponseSchema } },
      description: 'The sandbox status.',
    },
    500: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The readiness probe failed unexpectedly.',
    },
  },
});
