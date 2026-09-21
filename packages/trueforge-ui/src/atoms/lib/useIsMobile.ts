'use client';

import { useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

function getMediaQueryList(): MediaQueryList | null {
  // Guard `window` itself: `typeof window.matchMedia` throws a ReferenceError
  // when `window` is undefined (non-DOM runtimes).
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(MOBILE_QUERY);
}

function subscribe(callback: () => void) {
  const media = getMediaQueryList();
  if (media === null) return () => undefined;
  // MediaQueryList.addEventListener is missing on Safari < 14 and some older
  // webviews. Without the legacy fallback, mounting any consumer (e.g.
  // ThreadListContainer via AgentHistoryFilterButton/ChatFolderControls)
  // crashes with "media.addEventListener is not a function".
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', callback);
    return () => media.removeEventListener('change', callback);
  }
  media.addListener(callback);
  return () => media.removeListener(callback);
}

function getSnapshot() {
  return getMediaQueryList()?.matches ?? false;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
