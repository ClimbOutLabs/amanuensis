'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { isSkillsNotice, type SendRefusal } from '../utils/turnRefusal.js';

/** Why the chat's last send got no reply, told in one plain line. */
export type ChatNotice = {
  kind: SendRefusal;
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
  report: (kind: SendRefusal) => void;
  subscribe: (listener: (kind: SendRefusal) => void) => () => void;
};

export function createChatNoticeChannel(): ChatNoticeChannel {
  const listeners = new Set<(kind: SendRefusal) => void>();
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
const ReportChatNoticeContext = createContext<(kind: SendRefusal) => void>(() => undefined);

/** Lets a part of the chat page tell the chat's notice line something, outside a failed send. */
export function useReportChatNotice(): (kind: SendRefusal) => void {
  return useContext(ReportChatNoticeContext);
}

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
  const [notice, setNotice] = useState<{ kind: SendRefusal; sessionId: string | undefined } | null>(null);

  useEffect(
    () =>
      channel.subscribe(kind => {
        setNotice({ kind, sessionId });
        if (kind === 'previous_turn_running') reload();
      }),
    [channel, reload, sessionId],
  );

  // A notice raised before the first send belongs to the chat that send creates.
  useEffect(() => {
    if (notice != null && isSkillsNotice(notice.kind) && notice.sessionId === undefined && sessionId !== undefined) {
      setNotice({ ...notice, sessionId });
    }
  }, [notice, sessionId]);

  const report = useCallback((kind: SendRefusal) => setNotice({ kind, sessionId }), [sessionId]);

  const value = useMemo<ChatNotice | null>(
    () => (notice == null ? null : { ...notice, dismiss: () => setNotice(null) }),
    [notice],
  );
  return createElement(
    ReportChatNoticeContext.Provider,
    { value: report },
    createElement(ChatNoticeContext.Provider, { value }, children),
  );
}
