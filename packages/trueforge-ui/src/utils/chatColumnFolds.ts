import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which Chats column sections the person folded or opened, kept in local storage so a section stays
 * as they left it across screens and reloads. Storage can be blocked, so a failed read uses the
 * section's default and a failed write still updates the open tab.
 */
const STORAGE_KEY = 'aman-chat-column-folds';

const listeners = new Set<() => void>();

function readAll(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const folds: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') folds[key] = value;
    }
    return folds;
  } catch {
    return {};
  }
}

/** Choices that could not be saved, so this tab still follows them. */
const unsaved: Record<string, boolean> = {};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function setFold({ section, open }: { section: string; open: boolean }): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [section]: open }));
    delete unsaved[section];
  } catch {
    unsaved[section] = open;
  }
  for (const listener of listeners) listener();
}

/** Whether a Chats column section is open, and a toggle that remembers the choice. */
export function useChatColumnFold({
  section,
  defaultOpen,
}: {
  section: string;
  defaultOpen: boolean;
}): [open: boolean, toggle: () => void] {
  const read = () => unsaved[section] ?? readAll()[section] ?? defaultOpen;
  const open = useSyncExternalStore(subscribe, read, () => defaultOpen);
  const toggle = useCallback(() => setFold({ section, open: !open }), [section, open]);
  return [open, toggle];
}
