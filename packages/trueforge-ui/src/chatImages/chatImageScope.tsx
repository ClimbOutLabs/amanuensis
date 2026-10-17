'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { ChatImagesCatalog } from '../plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';
import { useOptionalServer } from '../server/ServerContext.js';

export interface ChatImageScopeValue {
  port: ChatImagesCatalog;
  sessionId: string;
  turnId: string;
  /** False while the turn still streams: the server can only check links it has stored. */
  settled: boolean;
}

/** `'no_images'` marks a chat turn that has no way to re-encode images, so none of them render. */
const ChatImageScopeContext = createContext<ChatImageScopeValue | 'no_images' | null>(null);

/**
 * Marks a part of the page as one chat turn. Inside it, Markdown shows only re-encoded images and
 * asks before any image from the web; outside it (Spaces, settings), Markdown keeps its own rules.
 */
export function ChatImageScope({
  children,
  port,
  sessionId,
  turnId,
  settled,
}: ChatImageScopeValue & { children: ReactNode }) {
  const value = useMemo(() => ({ port, sessionId, turnId, settled }), [port, sessionId, turnId, settled]);
  return <ChatImageScopeContext.Provider value={value}>{children}</ChatImageScopeContext.Provider>;
}

/** A chat turn without the image port or its session and turn ids: every image in it shows as not shown. */
export function ChatTurnWithoutImages({ children }: { children: ReactNode }) {
  return <ChatImageScopeContext.Provider value="no_images">{children}</ChatImageScopeContext.Provider>;
}

export function useChatImageScope(): ChatImageScopeValue | null {
  const value = useContext(ChatImageScopeContext);
  return value === 'no_images' ? null : value;
}

/** True inside any chat turn, scoped or not, where Markdown's outside-chat image rules never apply. */
export function useInsideChatTurn(): boolean {
  return useContext(ChatImageScopeContext) !== null;
}

function hasChatImagesPort(server: object): server is { chatImages: ChatImagesCatalog } {
  const port: unknown = Reflect.get(server, 'chatImages');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'listTurnImages') === 'function' &&
    typeof Reflect.get(port, 'showTurnImages') === 'function' &&
    typeof Reflect.get(port, 'imageUrl') === 'function'
  );
}

/** The trueforge adapter's chat images port, or null on a server that does not carry one. */
export function useChatImagesPort(): ChatImagesCatalog | null {
  const server = useOptionalServer();
  return server !== null && hasChatImagesPort(server) ? server.chatImages : null;
}

const CHAT_IMAGE_PATH = /\/api\/chat-images\/sessions\/[^/]+\/images\/[0-9a-f]{32}$/;

/** True for a same-origin re-encoded image address, the only image chat renders as an image. */
export function isChatImageSrc(src: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const url = new URL(src, window.location.href);
    return url.origin === window.location.origin && url.search === '' && CHAT_IMAGE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}
