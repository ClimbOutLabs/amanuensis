import { z } from '@hono/zod-openapi';

export const ExportDataRequestQuerySchema = z
  .object({
    include_uploads: z
      .stringbool()
      .optional()
      .describe('When true, uploaded file bytes are included under files/. Defaults to false.')
      .openapi({ type: 'boolean' }),
  })
  .openapi('ExportDataRequestQuery');
export type ExportDataRequestQuery = z.infer<typeof ExportDataRequestQuerySchema>;
