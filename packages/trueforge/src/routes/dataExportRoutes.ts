import { createRoute, z } from '@hono/zod-openapi';

import { ExportDataRequestQuerySchema } from '../schemas/dataExport';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const exportDataRoute = createRoute({
  method: 'get',
  path: '/export',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Export my data',
  description:
    'Streams a zip archive of everything the signed-in user owns here: chats, sessions, personas, spaces, schedules, connectors without credentials, settings, and memory. Stored secrets are removed before writing.',
  'x-fern-sdk-group-name': ['data'],
  'x-fern-sdk-method-name': 'export_data',
  request: {
    query: ExportDataRequestQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/zip': { schema: z.string().openapi({ format: 'binary' }) },
      },
      description: 'The export archive (zip).',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The signed-in user may not export data.',
    },
  },
});
