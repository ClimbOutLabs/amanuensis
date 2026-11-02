import { useSyncExternalStore } from 'react';

/**
 * A per-browser display choice, kept in local storage like the color theme. Storage can be blocked
 * (private mode), so a failed read falls back to the default and a failed write still updates the
 * open tab. A stored value `parse` does not accept also reads as the default.
 */
export function createDisplayPreference<T>({
  storageKey,
  defaultValue,
  parse,
  serialize,
}: {
  storageKey: string;
  defaultValue: T;
  parse: (stored: string) => T | undefined;
  serialize: (value: T) => string;
}) {
  const listeners = new Set<() => void>();

  function read(): T {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null ? defaultValue : (parse(stored) ?? defaultValue);
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

  function set(value: T): void {
    try {
      window.localStorage.setItem(storageKey, serialize(value));
    } catch {
      // Not persisted; this tab still follows the choice until it reloads.
    }
    for (const listener of listeners) listener();
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, read, () => defaultValue);
  }

  return { read, set, useValue };
}
