import { z } from '@hono/zod-openapi';
import { FolderFieldsSchema, FolderIdSchema, FolderNameSchema } from './folder';

export const SpaceFolderIdParamsSchema = z
  .object({ folder_id: FolderIdSchema.describe('Immutable space folder identifier.') })
  .openapi('SpaceFolderIDParams');

export const SpaceFolderSchema = z
  .object({ ...FolderFieldsSchema.shape })
  .strict()
  .openapi('SpaceFolder');

export const CreateSpaceFolderRequestSchema = z
  .object({ name: FolderNameSchema })
  .strict()
  .openapi('CreateSpaceFolderRequest');

export const UpdateSpaceFolderRequestSchema = z
  .object({ name: FolderNameSchema })
  .strict()
  .openapi('UpdateSpaceFolderRequest');

export const SetSpaceFolderRequestSchema = z
  .object({ folder_id: FolderIdSchema })
  .strict()
  .openapi('SetSpaceFolderRequest');

export const GetSpaceFolderResponseSchema = z.object({ data: SpaceFolderSchema }).openapi('GetSpaceFolderResponse');

export const ListSpaceFoldersResponseSchema = z
  .object({ data: z.array(SpaceFolderSchema) })
  .openapi('ListSpaceFoldersResponse');

export const DeleteSpaceFolderResponseSchema = z.object({}).openapi('DeleteSpaceFolderResponse');
export const SetSpaceFolderResponseSchema = z.object({}).openapi('SetSpaceFolderResponse');

export type SpaceFolder = z.infer<typeof SpaceFolderSchema>;
