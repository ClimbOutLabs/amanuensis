'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';

import type { DeliveriesApi, DeliveryItem } from './types.js';

/** How often an open page asks the server how many items are unread. */
export const DELIVERIES_POLL_MS = 30_000;
const PAGE_SIZE = 25;

type DeliveriesValue = {
  api: DeliveriesApi;
  /** Unread on the server, so every device shows the same number. */
  unreadCount: number;
  /** The newest items, newest first. */
  items: readonly DeliveryItem[];
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Marks items seen on the server, and updates the list at once. */
  markSeen: (ids: readonly string[]) => Promise<void>;
  /** Chats that have an unread item leading to them. */
  unreadChatIds: ReadonlySet<string>;
  /** Marks every unread item that leads to this chat as seen. */
  markChatSeen: (sessionId: string) => Promise<void>;
  /** An item a tapped push asked to open, until the app has shown it. */
  requestedId: string | null;
  requestOpen: (id: string | null) => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
};

const DeliveriesContext = createContext<DeliveriesValue | null>(null);

export function useOptionalDeliveries(): DeliveriesValue | null {
  return useContext(DeliveriesContext);
}

function chatIdOf(item: DeliveryItem): string | null {
  const link = item.link;
  return link !== null && (link.type === 'chat' || link.type === 'approval') ? link.sessionId : null;
}

/**
 * The server-side feed for the signed-in person. The unread count and the newest items come from the server, so a
 * tab that set nothing itself still shows them, and seen on one device is seen on all of them. While the page is
 * visible it asks every 30 seconds; the page keeps nothing about what was seen in the browser.
 */
export const DeliveriesProvider: FC<{ api: DeliveriesApi; pollMs?: number; children: ReactNode }> = ({
  api,
  pollMs = DELIVERIES_POLL_MS,
  children,
}) => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<readonly DeliveryItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(false);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const lastCount = useRef<number | null>(null);

  const loadFirstPage = useCallback(async () => {
    const page = await api.list({ limit: PAGE_SIZE });
    setItems(page.items);
    setNextPageToken(page.nextPageToken);
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const count = await api.unreadCount();
      setUnreadCount(count);
      // The list is fetched again only when something changed, or the first time.
      if (lastCount.current !== count) {
        lastCount.current = count;
        await loadFirstPage();
      }
    } catch {
      // A missed check is tried again on the next one.
    }
  }, [api, loadFirstPage]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  const loadMore = useCallback(async () => {
    if (nextPageToken === undefined) return;
    try {
      const page = await api.list({ limit: PAGE_SIZE, pageToken: nextPageToken });
      setItems(current => [...current, ...page.items]);
      setNextPageToken(page.nextPageToken);
    } catch {
      // The button stays, so the person can try again.
    }
  }, [api, nextPageToken]);

  const markSeen = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      setItems(current =>
        current.map(item => (ids.includes(item.id) && item.seenAt === null ? { ...item, seenAt: now } : item)),
      );
      try {
        const count = await api.markSeen(ids);
        lastCount.current = count;
        setUnreadCount(count);
      } catch {
        // The server still has them unread, so the next check puts the mark back.
        lastCount.current = null;
        void refresh();
      }
    },
    [api, refresh],
  );

  const unreadChatIds = useMemo(() => {
    const chats = new Set<string>();
    for (const item of items) {
      const chatId = item.seenAt === null ? chatIdOf(item) : null;
      if (chatId !== null) chats.add(chatId);
    }
    return chats;
  }, [items]);

  const markChatSeen = useCallback(
    async (sessionId: string) => {
      const ids = items.filter(item => item.seenAt === null && chatIdOf(item) === sessionId).map(item => item.id);
      await markSeen(ids);
    },
    [items, markSeen],
  );

  const value = useMemo<DeliveriesValue>(
    () => ({
      api,
      unreadCount,
      items,
      hasMore: nextPageToken !== undefined,
      loadMore,
      refresh,
      markSeen,
      unreadChatIds,
      markChatSeen,
      requestedId,
      requestOpen: setRequestedId,
      panelOpen,
      setPanelOpen,
    }),
    [
      api,
      unreadCount,
      items,
      nextPageToken,
      loadMore,
      refresh,
      markSeen,
      unreadChatIds,
      markChatSeen,
      requestedId,
      panelOpen,
    ],
  );

  return <DeliveriesContext.Provider value={value}>{children}</DeliveriesContext.Provider>;
};
