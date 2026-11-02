import { describe, expect, it, vi } from 'vitest';

import { createChatSearchCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/chatSearchCatalog.js';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createChatSearchCatalog searchOwnChats', () => {
  it('maps the snake_case hits from the chat search route', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://aman.example/api/v1/user/chat-search?query=ferry%20times');
      return json(200, {
        data: {
          search_enabled: true,
          hits: [
            {
              session_id: 's1',
              title: 'Trip',
              snippet: 'the ferry leaves at nine',
              matched_at: '2026-10-01T10:00:00.000Z',
            },
          ],
        },
      });
    });
    const catalog = createChatSearchCatalog({ baseUrl: 'https://aman.example/', fetch: fetchImpl });
    await expect(catalog.searchOwnChats({ query: 'ferry times' })).resolves.toEqual({
      searchEnabled: true,
      hits: [
        { sessionId: 's1', title: 'Trip', snippet: 'the ferry leaves at nine', matchedAt: '2026-10-01T10:00:00.000Z' },
      ],
    });
  });

  it('shows the server message for a refused search', async () => {
    const catalog = createChatSearchCatalog({
      fetch: async () => json(400, { error: { message: 'Type a word to search for.' } }),
    });
    await expect(catalog.searchOwnChats({ query: ' ' })).rejects.toThrow('Type a word to search for.');
  });

  it('keeps server error text away from the person for any other failure', async () => {
    const catalog = createChatSearchCatalog({
      fetch: async () => json(500, { error: { message: 'SQLITE_ERROR: no such table: chat_search_fts' } }),
    });
    await expect(catalog.searchOwnChats({ query: 'ferry' })).rejects.toThrow(
      'Searching your chats failed. Try again in a moment.',
    );
  });

  it('turns a network failure into plain words', async () => {
    const catalog = createChatSearchCatalog({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(catalog.searchOwnChats({ query: 'ferry' })).rejects.toThrow(
      'Searching your chats failed. Check your connection, then try again.',
    );
  });
});
