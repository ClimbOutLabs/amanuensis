'use client';

import { useCallback } from 'react';

import { useAui } from '../assistant-ui.js';
import { useOptionalServer } from '../server/ServerContext.js';

/** Max chat title length; mirrors `UpdateSessionRequestSchema.title` in packages/trueforge. */
export const CHAT_TITLE_MAX_LENGTH = 200;

/** Trims a typed chat title. An empty result must not be saved. */
export function normalizeChatTitle(value: string): string {
  return value.trim();
}

export type SaveChatTitle = (request: { sessionId: string; title: string }) => Promise<void>;

/**
 * Saves a chat title on the server, then renames the sidebar row. Rejects when the server
 * save fails. A failed local rename is ignored because the save already succeeded.
 * Returns null when no server is connected.
 */
export function useSaveChatTitle(): SaveChatTitle | null {
  const server = useOptionalServer();
  const aui = useAui();
  const save = useCallback<SaveChatTitle>(
    async ({ sessionId, title }) => {
      if (server == null) return;
      await server.updateSession({ sessionId, title });
      try {
        await aui.threadListItem().rename(title);
      } catch {
        // The server copy is saved; the sidebar name is a best-effort display update.
      }
    },
    [aui, server],
  );
  return server == null ? null : save;
}
