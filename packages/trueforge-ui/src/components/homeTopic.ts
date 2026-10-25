import { useSyncExternalStore } from 'react';

import { isHomeTopicId, type HomeTopicId } from './tourPrompts.js';

/**
 * The topic pill chosen on the home, kept in local storage so it stays chosen after a reload.
 * Storage can be blocked, so a failed read means no topic and a failed write still updates the tab.
 */
const STORAGE_KEY = 'aman-home-topic';

const listeners = new Set<() => void>();
let unsaved: { topic: HomeTopicId | null } | null = null;

function read(): HomeTopicId | null {
  if (unsaved !== null) return unsaved.topic;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && isHomeTopicId(stored) ? stored : null;
  } catch {
    return null;
  }
}

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

function setHomeTopic(topic: HomeTopicId | null): void {
  try {
    if (topic === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, topic);
    unsaved = null;
  } catch {
    unsaved = { topic };
  }
  for (const listener of listeners) listener();
}

/** The chosen topic, or null for the general cards, and a setter that remembers the choice. */
export function useHomeTopic(): [topic: HomeTopicId | null, setTopic: (topic: HomeTopicId | null) => void] {
  const topic = useSyncExternalStore(subscribe, read, () => null);
  return [topic, setHomeTopic];
}
