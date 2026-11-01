import { z } from '@hono/zod-openapi';
import { FolderFieldsSchema, FolderIdSchema, FolderNameSchema } from './folder';

export const SessionFolderIdParamsSchema = z
  .object({ folder_id: z.string().min(1).max(64).describe('Immutable session folder identifier.') })
  .openapi('SessionFolderIDParams');

export const SessionFolderSchema = z
  .object({ ...FolderFieldsSchema.shape })
  .strict()
  .openapi('SessionFolder');

export const CreateSessionFolderRequestSchema = z
  .object({ name: FolderNameSchema })
  .strict()
  .openapi('CreateSessionFolderRequest');

export const UpdateSessionFolderRequestSchema = z
  .object({ name: FolderNameSchema })
  .strict()
  .openapi('UpdateSessionFolderRequest');

export const SetSessionFolderRequestSchema = z
  .object({ folder_id: FolderIdSchema })
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
