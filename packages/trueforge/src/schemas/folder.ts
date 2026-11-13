/** Fields every owner-scoped folder (chat or space) shares on the wire. */
import { z } from '@hono/zod-openapi';

export const FolderIdSchema = z.string().min(1).max(64);

export const FolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('Folder name, trimmed to 1 through 64 characters.');

/** Unnamed on purpose: each kind adds its own `.openapi(...)` name so OpenAPI components stay distinct. */
export const FolderFieldsSchema = z.object({
  id: z.string().min(1).describe('Immutable server-generated folder identifier.'),
  name: FolderNameSchema,
  created_at: z.string().describe('ISO 8601 creation timestamp.'),
  updated_at: z.string().describe('ISO 8601 last-update timestamp.'),
});
