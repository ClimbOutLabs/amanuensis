import { z } from '@hono/zod-openapi';

export const ImportDataResultSchema = z
  .object({
    chats: z.number().int().nonnegative().describe('Chats imported.'),
    memories: z.number().int().nonnegative().describe('Memories imported.'),
    personas: z.number().int().nonnegative().describe('Personas imported.'),
    spaces: z.number().int().nonnegative().describe('Spaces imported.'),
    schedules: z.number().int().nonnegative().describe('Schedules imported; all arrive switched off.'),
    folders: z.number().int().nonnegative().describe('Chat folders imported.'),
    connectors: z.number().int().nonnegative().describe('Connectors imported, without credentials.'),
    connectors_skipped: z
      .number()
      .int()
      .nonnegative()
      .describe('Connectors skipped because a connector with the same name already exists.'),
    schedules_off: z
      .boolean()
      .describe('True when schedules were imported; imported schedules are always off until turned on.'),
    summary: z.string().describe('Plain-words summary of what was imported and what was not.'),
  })
  .openapi('ImportDataResult');

export const ImportDataResponseSchema = z.object({ data: ImportDataResultSchema }).openapi('ImportDataResponse');

export type ImportDataResult = z.infer<typeof ImportDataResultSchema>;
export type ImportDataResponse = z.infer<typeof ImportDataResponseSchema>;
