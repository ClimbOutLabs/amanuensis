import { useSyncExternalStore } from 'react';

/**
 * A per-browser on/off display switch, kept in local storage like the color theme. Storage can be
 * blocked (private mode), so a failed read falls back to the default and a failed write still
 * updates the open tab.
 */
export function createBooleanDisplayPreference({
  storageKey,
  defaultValue,
}: {
  storageKey: string;
  defaultValue: boolean;
}) {
  const listeners = new Set<() => void>();

  function readStored(): boolean {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null ? defaultValue : stored === 'true';
    } catch {
      return defaultValue;
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) listener();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  }

  function set(value: boolean): void {
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {
      // Not persisted; this tab still follows the choice until it reloads.
    }
    for (const listener of listeners) listener();
  }

  function useValue(): boolean {
    return useSyncExternalStore(subscribe, readStored, () => defaultValue);
  }

  return { set, useValue };
}
