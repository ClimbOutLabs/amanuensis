import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** The person's past-chat search switch: the assistant may search their own earlier chats when they ask. */
export interface ChatSearchSetting {
  enabled: boolean;
}

/** One of the person's own chats whose messages hold every searched word. */
export interface OwnChatSearchHit {
  sessionId: string;
  title: string | null;
  snippet: string;
  matchedAt: string;
}

/** `searchEnabled` is false while past-chat search is off; nothing is indexed then. */
export interface OwnChatSearchResult {
  searchEnabled: boolean;
  hits: OwnChatSearchHit[];
}

export interface ChatSearchCatalog {
  getChatSearch(): Promise<ChatSearchSetting>;
  setChatSearchEnabled(enabled: boolean): Promise<ChatSearchSetting>;
  searchOwnChats(input: { query: string; signal?: AbortSignal }): Promise<OwnChatSearchResult>;
}

/** Read-only shape probe: other servers carry no `chatSearch` port and report "not supported". */
export function hasChatSearchPort(server: object): server is { chatSearch: ChatSearchCatalog } {
  const port: unknown = Reflect.get(server, 'chatSearch');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getChatSearch') === 'function' &&
    typeof Reflect.get(port, 'setChatSearchEnabled') === 'function' &&
    typeof Reflect.get(port, 'searchOwnChats') === 'function'
  );
}

const ChatSearchResponseSchema = z.object({
  data: z.object({ chat_search_enabled: z.boolean().optional() }),
});

const OwnChatSearchResponseSchema = z.object({
  data: z.object({
    search_enabled: z.boolean(),
    hits: z.array(
      z.object({ session_id: z.string(), title: z.string().nullable(), snippet: z.string(), matched_at: z.string() }),
    ),
  }),
});

/**
 * Calls GET/PATCH /api/v1/user/settings/sentinel with the same base URL, token, and fetch the
 * SDK client was built from. The switch is one field of the person's settings; the response
 * carries them all and only this field is read here. A missing field reads as off.
 */
export function createChatSearchCatalog(options: CreateTrueForgeClientOptions = {}): ChatSearchCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PATCH', body?: { chat_search_enabled: boolean }): Promise<ChatSearchSetting> {
    const response = await fetchImpl(`${base}/api/v1/user/settings/sentinel`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success
          ? failure.data.error.message
          : `The past-chat search switch failed with HTTP ${String(response.status)}. Try again in a moment.`,
      );
    }
    const parsed = ChatSearchResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error(
        'The server sent back something unexpected for the past-chat search switch. Reload the page and try again.',
      );
    }
    return { enabled: parsed.data.data.chat_search_enabled ?? false };
  }

  async function searchOwnChats(input: { query: string; signal?: AbortSignal }): Promise<OwnChatSearchResult> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/v1/user/chat-search?query=${encodeURIComponent(input.query)}`, {
        method: 'GET',
        headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (caught) {
      if (input.signal?.aborted === true) {
        throw caught;
      }
      throw new Error('Searching your chats failed. Check your connection, then try again.', { cause: caught });
    }
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      // Only a refused search carries words meant for the person; any other failure text stays internal.
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        response.status === 400 && failure.success
          ? failure.data.error.message
          : 'Searching your chats failed. Try again in a moment.',
      );
    }
    const parsed = OwnChatSearchResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error('The server sent back something unexpected for the chat search. Reload the page and try again.');
    }
    return {
      searchEnabled: parsed.data.data.search_enabled,
      hits: parsed.data.data.hits.map(hit => ({
        sessionId: hit.session_id,
        title: hit.title,
        snippet: hit.snippet,
        matchedAt: hit.matched_at,
      })),
    };
  }

  return {
    getChatSearch: () => request('GET'),
    setChatSearchEnabled: enabled => request('PATCH', { chat_search_enabled: enabled }),
    searchOwnChats,
  };
}

/** Plain-words error for the switch; callers render it inline. */
export function chatSearchErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The past-chat search switch could not be saved. Try again in a moment.');
}
