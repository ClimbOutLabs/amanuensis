import { z } from '@hono/zod-openapi';

/** The most chats one chat-list search returns. */
export const CHAT_LIST_SEARCH_MAX_HITS = 20;

export const SearchOwnChatsRequestQuerySchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, 'Type a word to search for.')
      .max(500, 'Use at most 500 characters.')
      .describe('Words to look for. A chat matches when one message holds every word.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CHAT_LIST_SEARCH_MAX_HITS)
      .optional()
      .default(CHAT_LIST_SEARCH_MAX_HITS)
      .describe('Most chats to return.'),
  })
  .openapi('SearchOwnChatsRequestQuery');

export const OwnChatSearchHitSchema = z
  .object({
    session_id: z.string(),
    title: z.string().nullable(),
    snippet: z.string().describe('Part of the matching message, at most 300 characters.'),
    matched_at: z.iso.datetime().describe('When the matching message was written.'),
  })
  .openapi('OwnChatSearchHit');

export const SearchOwnChatsResponseSchema = z
  .object({
    data: z.object({
      search_enabled: z
        .boolean()
        .describe('False while past-chat search is off in Settings; nothing is indexed then and hits is empty.'),
      hits: z.array(OwnChatSearchHitSchema).describe('Newest match first, one per chat.'),
    }),
  })
  .openapi('SearchOwnChatsResponse');
