import { useSyncExternalStore } from 'react';

/**
 * Whether the model and cost line is shown under answers. A display preference only: the server
 * records usage either way. Kept in this browser like the color theme, and on unless switched off.
 */
export const MODEL_USAGE_DISPLAY_STORAGE_KEY = 'aman.show_model_usage';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(MODEL_USAGE_DISPLAY_STORAGE_KEY) !== 'false';
  } catch {
    // Storage can be blocked (private mode); the default is on.
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === MODEL_USAGE_DISPLAY_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setModelUsageVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(MODEL_USAGE_DISPLAY_STORAGE_KEY, String(visible));
  } catch {
    // Not persisted; this tab still follows the choice until it reloads.
  }
  for (const listener of listeners) listener();
}

/** The per-user display switch for the model and cost line, and its setter. */
export function useModelUsageVisible(): { visible: boolean; setVisible: (visible: boolean) => void } {
  const visible = useSyncExternalStore(subscribe, readStored, () => true);
  return { visible, setVisible: setModelUsageVisible };
}
