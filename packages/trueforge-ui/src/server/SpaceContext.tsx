'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type SpaceStatus = 'active' | 'archived';

/** `markdown` renders the body as markdown; `html` renders it in a sandboxed, sanitised iframe. */
export type SpaceFormat = 'markdown' | 'html';

export type Space = {
  id: string;
  name: string;
  purpose: string;
  status: SpaceStatus;
  body: string;
  format: SpaceFormat;
  revision: number;
  created_at: string;
  updated_at: string;
};

/**
 * Host-owned persistence for spaces: durable pages the model creates and updates through tools.
 * `delete` is UI-only; no tool exposes it to the model (see `spaceCapability.ts`).
 */
export interface SpaceStore {
  list(): Promise<Space[]>;
  get(input: { spaceId: string }): Promise<Space>;
  delete(input: { spaceId: string; expectedRevision: number }): Promise<void>;
}

type SpaceContextValue = {
  spaces: readonly Space[];
  loading: boolean;
  error: string | null;
  refresh(): void;
  getSpace(input: { spaceId: string }): Promise<Space>;
  deleteSpace(input: { spaceId: string; expectedRevision: number }): Promise<void>;
};

const SpaceContext = createContext<SpaceContextValue | null>(null);

function sortSpaces(spaces: readonly Space[]): Space[] {
  return [...spaces].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads the space list on mount and refreshes it on window focus, so a space the model created or
 * updated in another tab (or earlier in this one) shows current data without a manual reload.
 */
export function SpaceProvider({ store, children }: { store?: SpaceStore; children: ReactNode }) {
  const [spaces, setSpaces] = useState<readonly Space[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mirrors `spaces` for `load` to read synchronously without depending on it: `load`'s identity
  // must stay tied to `store` alone, or the mount effect below (`[load]`) would refetch on every
  // successful load. Assigning during render keeps this current before the next `load()` call.
  const spacesRef = useRef<readonly Space[]>(spaces);
  spacesRef.current = spaces;

  const load = useCallback(() => {
    if (store === undefined) {
      setSpaces([]);
      return;
    }
    // Show the loading state only when there is nothing to show yet. A refresh behind an
    // already-populated list should not flash it away; deriving this from the current list
    // (rather than a flag set from the previous fetch's result) keeps it correct even when a
    // fetch that empties the list is itself still in flight.
    if (spacesRef.current.length === 0) setLoading(true);
    void store
      .list()
      .then(rows => {
        setSpaces(sortSpaces(rows));
        setError(null);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Failed to load spaces');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [store]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (store === undefined) return;
    // Window `focus` and document `visibilitychange` both fire when the tab regains focus;
    // collapse them into a single refresh instead of loading twice.
    let refreshScheduled = false;
    const scheduleRefresh = () => {
      if (document.visibilityState !== 'visible' || refreshScheduled) return;
      refreshScheduled = true;
      queueMicrotask(() => {
        refreshScheduled = false;
        load();
      });
    };
    window.addEventListener('focus', scheduleRefresh);
    document.addEventListener('visibilitychange', scheduleRefresh);
    return () => {
      window.removeEventListener('focus', scheduleRefresh);
      document.removeEventListener('visibilitychange', scheduleRefresh);
    };
  }, [load, store]);

  const getSpace = useCallback(
    async ({ spaceId }: { spaceId: string }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      return store.get({ spaceId });
    },
    [store],
  );

  const deleteSpace = useCallback(
    async ({ spaceId, expectedRevision }: { spaceId: string; expectedRevision: number }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      await store.delete({ spaceId, expectedRevision });
      load();
    },
    [load, store],
  );

  const value = useMemo<SpaceContextValue | null>(() => {
    if (store === undefined) return null;
    return { spaces, loading, error, refresh: load, getSpace, deleteSpace };
  }, [deleteSpace, error, getSpace, load, loading, spaces, store]);

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useOptionalSpaces(): SpaceContextValue | null {
  return useContext(SpaceContext);
}
