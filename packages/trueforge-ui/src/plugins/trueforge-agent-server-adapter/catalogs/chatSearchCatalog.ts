import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** The person's past-chat search switch: the assistant may search their own earlier chats when they ask. */
export interface ChatSearchSetting {
  enabled: boolean;
}

export interface ChatSearchCatalog {
  getChatSearch(): Promise<ChatSearchSetting>;
  setChatSearchEnabled(enabled: boolean): Promise<ChatSearchSetting>;
}

const ChatSearchResponseSchema = z.object({
  data: z.object({ chat_search_enabled: z.boolean().optional() }),
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

  return {
    getChatSearch: () => request('GET'),
    setChatSearchEnabled: enabled => request('PATCH', { chat_search_enabled: enabled }),
  };
}

/** Plain-words error for the switch; callers render it inline. */
export function chatSearchErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The past-chat search switch could not be saved. Try again in a moment.');
}
