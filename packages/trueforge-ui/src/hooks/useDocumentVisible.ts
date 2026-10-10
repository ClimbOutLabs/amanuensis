'use client';

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
  };
}

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

// No document during a server render; nothing polls there, so report visible.
function isServerVisible(): boolean {
  return true;
}

/** Whether the page is visible, so pollers can pause in a background tab and resume when shown. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, isDocumentVisible, isServerVisible);
}
