'use client';

import { useEffect, useRef } from 'react';

/** How often the chat list refreshes itself while it stays on screen. */
export const CHAT_LIST_REFRESH_INTERVAL_MS = 60_000;
/** Focus and visibility events fire together; this window folds them into one refresh. */
const CHAT_LIST_REFRESH_DEBOUNCE_MS = 500;

/**
 * The one refresh path for the chat list. It runs when the app or tab comes back to
 * the front (the same triggers the per-chat foreground sync uses: visibility, focus,
 * and a page restored from the back-forward cache) and about once a minute while the
 * list is visible, so chats created or deleted elsewhere appear without a page reload.
 */
export function useChatListRefresh({ onRefresh }: { onRefresh: () => void }): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let debounceId: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => refreshRef.current();
    const scheduleRefresh = () => {
      if (debounceId !== undefined) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        debounceId = undefined;
        if (!document.hidden) refresh();
      }, CHAT_LIST_REFRESH_DEBOUNCE_MS);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) scheduleRefresh();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) scheduleRefresh();
    };
    const intervalId = setInterval(() => {
      if (!document.hidden) refresh();
    }, CHAT_LIST_REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', scheduleRefresh);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', scheduleRefresh);
      window.removeEventListener('pageshow', onPageShow);
      clearInterval(intervalId);
      if (debounceId !== undefined) clearTimeout(debounceId);
    };
  }, []);
}
