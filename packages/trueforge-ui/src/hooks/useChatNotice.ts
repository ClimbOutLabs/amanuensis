'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Something about a chat's last send that the person needs to know, told in one plain line:
 * the server refused the send because the previous reply is still running, or a reply stopped
 * because the server restarted under it.
 */
export type ChatNoticeKind = 'previous-turn-running' | 'stopped-by-restart';

export type ChatNotice = {
  kind: ChatNoticeKind;
  /** The chat it is about; it only shows there. */
  sessionId: string | undefined;
  /** Clears the line once the person sends again. */
  dismiss: () => void;
};

/**
 * Per-chat channel for notices. The chat provider reports here (its `onError` sits outside the
 * runtime), and `ChatNoticeProvider` inside the runtime turns a report into what the chat shows.
 */
export type ChatNoticeChannel = {
  report: (kind: ChatNoticeKind) => void;
  subscribe: (listener: (kind: ChatNoticeKind) => void) => () => void;
};

export function createChatNoticeChannel(): ChatNoticeChannel {
  const listeners = new Set<(kind: ChatNoticeKind) => void>();
  return {
    report: kind => {
      for (const listener of listeners) listener(kind);
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const ChatNoticeContext = createContext<ChatNotice | null>(null);

/** The notice for the chat this component renders in, if any. */
export function useChatNotice(): ChatNotice | null {
  const notice = useContext(ChatNoticeContext);
  const sessionId = useAuiState(state => state.threadListItem?.remoteId ?? undefined);
  return notice != null && notice.sessionId === sessionId ? notice : null;
}

/**
 * Holds the chat's notice. A refused send re-attaches the chat to the reply that is still
 * running, so the person sees it and can wait for it or cancel it.
 */
export function ChatNoticeProvider({ channel, children }: { channel: ChatNoticeChannel; children?: ReactNode }) {
  const reload = useTrueFoundryReload();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId ?? undefined);
  const [notice, setNotice] = useState<{ kind: ChatNoticeKind; sessionId: string | undefined } | null>(null);

  useEffect(
    () =>
      channel.subscribe(kind => {
        setNotice({ kind, sessionId });
        if (kind === 'previous-turn-running') reload();
      }),
    [channel, reload, sessionId],
  );

  const value = useMemo<ChatNotice | null>(
    () => (notice == null ? null : { ...notice, dismiss: () => setNotice(null) }),
    [notice],
  );
  return createElement(ChatNoticeContext.Provider, { value }, children);
}
