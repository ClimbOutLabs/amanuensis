import { createRoute, z } from '@hono/zod-openapi';

import { ExportDataRequestSchema } from '../schemas/dataExport';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const exportDataRoute = createRoute({
  method: 'post',
  path: '/export',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Export my data',
  description:
    'Streams a zip archive of what the signed-in user owns: chats, sessions, agents, personas, spaces, schedules, connectors without credentials, settings, and memory. Administrators also get instance-wide memory. Stored secrets are removed. The JSON body is required.',
  'x-fern-sdk-group-name': ['data'],
  'x-fern-sdk-method-name': 'export_data',
  request: {
    body: {
      content: { 'application/json': { schema: ExportDataRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/zip': { schema: z.string().openapi({ format: 'binary' }) },
      },
      description: 'The export archive (zip). A failed export drops the connection instead of ending the archive.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The request body is missing or invalid.',
    },
    415: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The request body is not application/json.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
  },
});
