'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ChatFolder = {
  id: string;
  name: string;
};

export type ChatFolderSnapshot = {
  folders: ChatFolder[];
  assignments: Array<{ sessionId: string; folderId: string }>;
};

/** Host-owned persistence for organizing remote chats. */
export interface ChatFolderStore {
  load(): Promise<ChatFolderSnapshot>;
  createFolder(input: { name: string }): Promise<ChatFolder>;
  renameFolder(input: { folderId: string; name: string }): Promise<ChatFolder>;
  deleteFolder(input: { folderId: string }): Promise<void>;
  setSessionFolder(input: { sessionId: string; folderId: string | null }): Promise<void>;
}

type ChatFolderContextValue = {
  folders: readonly ChatFolder[];
  assignments: ReadonlyMap<string, string>;
  createFolder(input: { name: string }): Promise<ChatFolder>;
  renameFolder(input: { folderId: string; name: string }): Promise<void>;
  deleteFolder(input: { folderId: string }): Promise<void>;
  moveChat(input: { sessionId: string; folderId: string | null }): Promise<void>;
};

const ChatFolderContext = createContext<ChatFolderContextValue | null>(null);

function sortFolders(folders: readonly ChatFolder[]): ChatFolder[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name));
}

export function ChatFolderProvider({ store, children }: { store?: ChatFolderStore; children: ReactNode }) {
  const [folders, setFolders] = useState<readonly ChatFolder[]>([]);
  const [assignments, setAssignments] = useState<ReadonlyMap<string, string>>(() => new Map());

  useEffect(() => {
    if (store === undefined) {
      setFolders([]);
      setAssignments(new Map());
      return;
    }

    let cancelled = false;
    void store
      .load()
      .then(snapshot => {
        if (cancelled) return;
        setFolders(sortFolders(snapshot.folders));
        setAssignments(new Map(snapshot.assignments.map(row => [row.sessionId, row.folderId])));
      })
      .catch(() => {
        // Folder organization is optional. Keep chat history usable if it cannot load.
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const createFolder = useCallback(
    async ({ name }: { name: string }) => {
      if (store === undefined) throw new Error('Chat folders are not available on this server');
      const created = await store.createFolder({ name });
      setFolders(current => sortFolders([...current, created]));
      return created;
    },
    [store],
  );

  const renameFolder = useCallback(
    async ({ folderId, name }: { folderId: string; name: string }) => {
      if (store === undefined) throw new Error('Chat folders are not available on this server');
      const renamed = await store.renameFolder({ folderId, name });
      setFolders(current => sortFolders(current.map(folder => (folder.id === folderId ? renamed : folder))));
    },
    [store],
  );

  const deleteFolder = useCallback(
    async ({ folderId }: { folderId: string }) => {
      if (store === undefined) throw new Error('Chat folders are not available on this server');
      await store.deleteFolder({ folderId });
      setFolders(current => current.filter(folder => folder.id !== folderId));
      setAssignments(current => new Map([...current].filter(([, assignedFolderId]) => assignedFolderId !== folderId)));
    },
    [store],
  );

  const moveChat = useCallback(
    async ({ sessionId, folderId }: { sessionId: string; folderId: string | null }) => {
      if (store === undefined) throw new Error('Chat folders are not available on this server');
      const previous = assignments.get(sessionId);
      setAssignments(current => {
        const next = new Map(current);
        if (folderId === null) next.delete(sessionId);
        else next.set(sessionId, folderId);
        return next;
      });
      try {
        await store.setSessionFolder({ sessionId, folderId });
      } catch (error) {
        setAssignments(current => {
          const next = new Map(current);
          if (previous === undefined) next.delete(sessionId);
          else next.set(sessionId, previous);
          return next;
        });
        throw error;
      }
    },
    [assignments, store],
  );

  const value = useMemo<ChatFolderContextValue | null>(() => {
    if (store === undefined) return null;
    return { folders, assignments, createFolder, renameFolder, deleteFolder, moveChat };
  }, [assignments, createFolder, deleteFolder, folders, moveChat, renameFolder, store]);

  return <ChatFolderContext.Provider value={value}>{children}</ChatFolderContext.Provider>;
}

export function useOptionalChatFolders(): ChatFolderContextValue | null {
  return useContext(ChatFolderContext);
}
