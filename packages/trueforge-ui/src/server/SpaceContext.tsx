'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type SpaceStatus = 'active' | 'archived';

/** `markdown` renders the body as markdown; `html` renders it in a sandboxed, sanitised iframe. */
export type SpaceFormat = 'markdown' | 'html';

export type SpaceFolder = {
  id: string;
  name: string;
};

export type Space = {
  id: string;
  name: string;
  purpose: string;
  status: SpaceStatus;
  body: string;
  format: SpaceFormat;
  /** The folder the space sits in, or null when it is not in one. */
  folder_id: string | null;
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
  listFolders(): Promise<SpaceFolder[]>;
  createFolder(input: { name: string }): Promise<SpaceFolder>;
  renameFolder(input: { folderId: string; name: string }): Promise<SpaceFolder>;
  /** Removes the folder only; its spaces stay and become unfiled. */
  deleteFolder(input: { folderId: string }): Promise<void>;
  /** Moving a space is not an edit: its revision and update time stay as they were. */
  setSpaceFolder(input: { spaceId: string; folderId: string | null }): Promise<void>;
}

type SpaceContextValue = {
  spaces: readonly Space[];
  loading: boolean;
  error: string | null;
  refresh(): void;
  getSpace(input: { spaceId: string }): Promise<Space>;
  deleteSpace(input: { spaceId: string; expectedRevision: number }): Promise<void>;
  folders: readonly SpaceFolder[];
  createFolder(input: { name: string }): Promise<SpaceFolder>;
  renameFolder(input: { folderId: string; name: string }): Promise<void>;
  deleteFolder(input: { folderId: string }): Promise<void>;
  moveSpace(input: { spaceId: string; folderId: string | null }): Promise<void>;
};

const SpaceContext = createContext<SpaceContextValue | null>(null);

function sortSpaces(spaces: readonly Space[]): Space[] {
  return [...spaces].sort((a, b) => a.name.localeCompare(b.name));
}

function sortFolders(folders: readonly SpaceFolder[]): SpaceFolder[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Loads the space list on mount and refreshes it on window focus, so a space the model created or
 * updated in another tab shows current data without a manual reload. The in-tab loop (chat → the
 * model creates or updates a space → the user opens Spaces without the tab losing focus) is not
 * covered here: `SpacesView` refreshes on every open and selection change instead.
 */
export function SpaceProvider({ store, children }: { store?: SpaceStore; children: ReactNode }) {
  const [spaces, setSpaces] = useState<readonly Space[]>([]);
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<readonly SpaceFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Mirrors `spaces` for `load` to read synchronously without depending on it: `load`'s identity
  // must stay tied to `store` alone, or the mount effect below (`[load]`) would refetch on every
  // successful load. Assigning during render keeps this current before the next `load()` call.
  const spacesRef = useRef<readonly Space[]>(spaces);
  spacesRef.current = spaces;

  const load = useCallback(() => {
    if (store === undefined) {
      setSpaces([]);
      setFolders([]);
      return;
    }
    // Show the loading state only when there is nothing to show yet. A refresh behind an
    // already-populated list should not flash it away; deriving this from the current list
    // (rather than a flag set from the previous fetch's result) keeps it correct even when a
    // fetch that empties the list is itself still in flight.
    if (spacesRef.current.length === 0) setLoading(true);
    void Promise.all([store.list(), store.listFolders()])
      .then(([rows, folderRows]) => {
        setSpaces(sortSpaces(rows));
        setFolders(sortFolders(folderRows));
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

  const createFolder = useCallback(
    async ({ name }: { name: string }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      const created = await store.createFolder({ name });
      setFolders(current => sortFolders([...current, created]));
      return created;
    },
    [store],
  );

  const renameFolder = useCallback(
    async ({ folderId, name }: { folderId: string; name: string }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      const renamed = await store.renameFolder({ folderId, name });
      setFolders(current => sortFolders(current.map(folder => (folder.id === folderId ? renamed : folder))));
    },
    [store],
  );

  const deleteFolder = useCallback(
    async ({ folderId }: { folderId: string }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      await store.deleteFolder({ folderId });
      setFolders(current => current.filter(folder => folder.id !== folderId));
      // Deleting a folder keeps its spaces: they join the ones that have no folder.
      setSpaces(current =>
        current.map(space => (space.folder_id === folderId ? { ...space, folder_id: null } : space)),
      );
    },
    [store],
  );

  const moveSpace = useCallback(
    async ({ spaceId, folderId }: { spaceId: string; folderId: string | null }) => {
      if (store === undefined) throw new Error('Spaces are not available on this server');
      const previous = spacesRef.current.find(space => space.id === spaceId)?.folder_id ?? null;
      const place = (target: string | null) =>
        setSpaces(current => current.map(space => (space.id === spaceId ? { ...space, folder_id: target } : space)));
      place(folderId);
      try {
        await store.setSpaceFolder({ spaceId, folderId });
      } catch (caught) {
        place(previous);
        throw caught;
      }
    },
    [store],
  );

  const value = useMemo<SpaceContextValue | null>(() => {
    if (store === undefined) return null;
    return {
      spaces,
      loading,
      error,
      refresh: load,
      getSpace,
      deleteSpace,
      folders,
      createFolder,
      renameFolder,
      deleteFolder,
      moveSpace,
    };
  }, [
    createFolder,
    deleteFolder,
    deleteSpace,
    error,
    folders,
    getSpace,
    load,
    loading,
    moveSpace,
    renameFolder,
    spaces,
    store,
  ]);

  return <SpaceContext.Provider value={value}>{children}</SpaceContext.Provider>;
}

export function useOptionalSpaces(): SpaceContextValue | null {
  return useContext(SpaceContext);
}
