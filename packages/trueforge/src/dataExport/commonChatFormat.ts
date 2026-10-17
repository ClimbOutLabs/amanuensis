/**
 * The common chat format: the provider-agnostic shape every chat import and
 * export speaks. Aman's own data export writes its chats section in exactly
 * this format, so Aman-to-Aman transfers go through the same path as imports
 * from any other provider (each provider only needs a mapping into this
 * shape, never into Aman's storage).
 *
 * Deliberately small: a chat is a title, timestamps, an optional folder name,
 * and a flat list of messages. Storage-level detail (turns, threads, events,
 * snapshots) is NOT part of this format; Aman's export carries that
 * separately in its sessions section for full-fidelity restores.
 */
import { z } from '@hono/zod-openapi';

/** A file attached to a message. `path` is set when the bytes ride in the same archive. */
export const CommonChatFileSchema = z.object({
  name: z.string().min(1).describe('File name as shown to the user.'),
  mime: z.string().optional().describe('Media type of the file, when known.'),
  path: z
    .string()
    .optional()
    .describe('Archive-relative path of the file bytes, when they are included in the same archive.'),
});
export type CommonChatFile = z.infer<typeof CommonChatFileSchema>;

export const CommonChatMessageSchema = z.object({
  author: z
    .enum(['you', 'assistant', 'other'])
    .describe('Who wrote the message: the user, the assistant, or anyone else (named via text).'),
  text: z.string().describe('Message body as Markdown.'),
  time: z.string().describe('ISO 8601 instant the message was written.'),
  files: z.array(CommonChatFileSchema).optional().describe('Files attached to this message.'),
});
export type CommonChatMessage = z.infer<typeof CommonChatMessageSchema>;

export const CommonChatSchema = z.object({
  title: z.string().describe('Chat title.'),
  created_at: z.string().describe('ISO 8601 instant the chat was created.'),
  updated_at: z.string().describe('ISO 8601 instant the chat last changed.'),
  folder: z.string().optional().describe('Name of the folder the chat lives in, when it has one.'),
  messages: z.array(CommonChatMessageSchema).describe('The chat messages, oldest first.'),
});
export type CommonChat = z.infer<typeof CommonChatSchema>;

/** The chats section of an export archive: one JSON array of common chats. */
export const CommonChatExportFileSchema = z.array(CommonChatSchema);
export type CommonChatExportFile = z.infer<typeof CommonChatExportFileSchema>;
