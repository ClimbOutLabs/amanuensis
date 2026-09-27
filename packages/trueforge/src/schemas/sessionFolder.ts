import { z } from '@hono/zod-openapi';

export const SessionFolderIdParamsSchema = z
  .object({ folder_id: z.string().min(1).max(64).describe('Immutable session folder identifier.') })
  .openapi('SessionFolderIDParams');

export const SessionFolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('Folder name, trimmed to 1 through 64 characters.');

export const SessionFolderSchema = z
  .object({
    id: z.string().min(1).describe('Immutable server-generated folder identifier.'),
    name: SessionFolderNameSchema,
    created_at: z.string().describe('ISO 8601 creation timestamp.'),
    updated_at: z.string().describe('ISO 8601 last-update timestamp.'),
  })
  .strict()
  .openapi('SessionFolder');

export const CreateSessionFolderRequestSchema = z
  .object({ name: SessionFolderNameSchema })
  .strict()
  .openapi('CreateSessionFolderRequest');

export const UpdateSessionFolderRequestSchema = z
  .object({ name: SessionFolderNameSchema })
  .strict()
  .openapi('UpdateSessionFolderRequest');

export const SetSessionFolderRequestSchema = z
  .object({ folder_id: z.string().min(1).max(64) })
  .strict()
  .openapi('SetSessionFolderRequest');

export const GetSessionFolderResponseSchema = z
  .object({ data: SessionFolderSchema })
  .openapi('GetSessionFolderResponse');

export const ListSessionFoldersResponseSchema = z
  .object({ data: z.array(SessionFolderSchema) })
  .openapi('ListSessionFoldersResponse');

export const DeleteSessionFolderResponseSchema = z.object({}).openapi('DeleteSessionFolderResponse');
export const SetSessionFolderResponseSchema = z.object({}).openapi('SetSessionFolderResponse');

export type SessionFolder = z.infer<typeof SessionFolderSchema>;
