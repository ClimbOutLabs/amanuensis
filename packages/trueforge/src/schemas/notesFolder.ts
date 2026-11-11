import { z } from '@hono/zod-openapi';
import { ConnectorAccountStateSchema } from './connectorAccount';

export const NotesFolderStatusSchema = z
  .object({
    state: ConnectorAccountStateSchema,
    folder_path: z
      .string()
      .nullable()
      .describe('The folder of notes the person connected; null when no folder is connected.'),
    inbox_file: z
      .string()
      .describe('The file inside the folder that inbox entries are added to; the default name until one is picked.'),
    note_count: z
      .number()
      .int()
      .nullable()
      .describe('How many notes the folder holds; null when no folder is connected or it cannot be read right now.'),
  })
  .openapi('NotesFolderStatus');

export const GetNotesFolderResponseSchema = z
  .object({ data: NotesFolderStatusSchema })
  .openapi('GetNotesFolderResponse');

export const SaveNotesFolderRequestSchema = z
  .object({
    folder_path: z.string().describe('The path of the folder of Markdown notes, on the computer Aman runs on.'),
    inbox_file: z
      .string()
      .optional()
      .describe('The file in the folder that inbox entries are added to; the default name when left out.'),
  })
  .openapi('SaveNotesFolderRequest');

export const SaveNotesFolderResponseSchema = z
  .object({ data: NotesFolderStatusSchema })
  .openapi('SaveNotesFolderResponse');

export const RemoveNotesFolderResponseSchema = z
  .object({ data: NotesFolderStatusSchema })
  .openapi('RemoveNotesFolderResponse');

export type NotesFolderStatus = z.infer<typeof NotesFolderStatusSchema>;
export type SaveNotesFolderRequest = z.infer<typeof SaveNotesFolderRequestSchema>;
