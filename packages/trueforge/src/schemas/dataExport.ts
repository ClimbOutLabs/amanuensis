import { z } from '@hono/zod-openapi';

export const ExportDataRequestSchema = z
  .object({
    include_uploads: z
      .boolean()
      .optional()
      .describe('When true, uploaded file bytes are included under files/. Defaults to false.'),
  })
  .openapi('ExportDataRequest');
export type ExportDataRequest = z.infer<typeof ExportDataRequestSchema>;
