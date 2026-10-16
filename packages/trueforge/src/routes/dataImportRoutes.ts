import { createRoute, z } from '@hono/zod-openapi';

import { ImportDataResponseSchema } from '../schemas/dataImport';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

export const importDataRoute = createRoute({
  method: 'post',
  path: '/import',
  tags: [OpenApiTag.CAPABILITIES],
  summary: 'Import my data',
  description:
    'Imports an export archive into an empty instance. Everything in the archive is checked before anything is written; imported records belong to the signed-in user, ids are kept, and schedules arrive switched off.',
  'x-fern-sdk-group-name': ['data'],
  'x-fern-sdk-method-name': 'import_data',
  request: {
    body: {
      content: {
        'application/zip': { schema: z.string().openapi({ format: 'binary' }) },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ImportDataResponseSchema } },
      description: 'The import finished; the summary says what arrived and what did not.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The file is not a valid export, or was made by a newer version.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Authentication required.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'This instance already has data; imports only run into an empty instance.',
    },
    413: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The file is larger than the import limit.',
    },
  },
});
