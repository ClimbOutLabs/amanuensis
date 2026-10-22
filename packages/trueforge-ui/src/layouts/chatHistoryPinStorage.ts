const CHAT_HISTORY_PINNED_STORAGE_KEY = 'aui-history-pinned';

/** Storage can be blocked or full, so any failure reads as unpinned. */
export function readStoredChatHistoryPinned(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CHAT_HISTORY_PINNED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeStoredChatHistoryPinned(pinned: boolean): void {
  try {
    window.localStorage.setItem(CHAT_HISTORY_PINNED_STORAGE_KEY, String(pinned));
  } catch {
    /* The pin still works for this visit. */
  }
}
