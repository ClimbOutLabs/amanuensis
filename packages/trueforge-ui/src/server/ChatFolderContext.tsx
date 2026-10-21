'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ChatFolder = {
  id: string;
  name: string;
};

/** One chat in a folder, as the sidebar needs it, loaded from the server by folder. */
export type ChatFolderSession = {
  sessionId: string;
  title: string | null;
  updatedAt: Date;
  agentName: string | null;
  isMutable: boolean;
};

export type ChatFolderSnapshot = {
  folders: ChatFolder[];
  assignments: Array<{ sessionId: string; folderId: string }>;
  folderSessions: Array<{ folderId: string; sessions: ChatFolderSession[] }>;
  /** Chats with no folder, loaded from the server like the folder chats. */
  unfiledSessions: ChatFolderSession[];
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
  folderSessions: ReadonlyMap<string, readonly ChatFolderSession[]>;
  unfiledSessions: readonly ChatFolderSession[];
  loadError: string | null;
  createFolder(input: { name: string }): Promise<ChatFolder>;
  renameFolder(input: { folderId: string; name: string }): Promise<void>;
  deleteFolder(input: { folderId: string }): Promise<void>;
  moveChat(input: { sessionId: string; folderId: string | null }): Promise<void>;
  /** Keeps a folder row's title in step after a rename saved through the server. */
  updateFolderSessionTitle(input: { sessionId: string; title: string }): void;
  /** Drops a folder row after its chat was deleted through the server. */
  removeFolderSession(input: { sessionId: string }): void;
};

const ChatFolderContext = createContext<ChatFolderContextValue | null>(null);

function sortFolders(folders: readonly ChatFolder[]): ChatFolder[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name));
}

export function ChatFolderProvider({ store, children }: { store?: ChatFolderStore; children: ReactNode }) {
  const [folders, setFolders] = useState<readonly ChatFolder[]>([]);
  const [assignments, setAssignments] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [folderSessions, setFolderSessions] = useState<ReadonlyMap<string, readonly ChatFolderSession[]>>(
    () => new Map(),
  );
  const [unfiledSessions, setUnfiledSessions] = useState<readonly ChatFolderSession[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (store === undefined) {
      setFolders([]);
      setAssignments(new Map());
      setFolderSessions(new Map());
      setUnfiledSessions([]);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    void store
      .load()
      .then(snapshot => {
        if (cancelled) return;
        setFolders(sortFolders(snapshot.folders));
        setAssignments(new Map(snapshot.assignments.map(row => [row.sessionId, row.folderId])));
        setFolderSessions(new Map(snapshot.folderSessions.map(row => [row.folderId, row.sessions])));
        setUnfiledSessions(snapshot.unfiledSessions);
        setLoadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // Folder organization is optional. Keep chat history usable if it cannot load.
        setLoadError('Could not load folder chats. Refresh the page to try again.');
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
      // Deleting a folder keeps its chats: they land with the chats that have no
      // folder instead of disappearing from the list.
      setUnfiledSessions(current => {
        const orphaned = folderSessions.get(folderId) ?? [];
        if (orphaned.length === 0) return current;
        const known = new Set(current.map(session => session.sessionId));
        const additions = orphaned.filter(session => !known.has(session.sessionId));
        return additions.length === 0 ? current : [...current, ...additions];
      });
      setFolderSessions(current => {
        const next = new Map(current);
        next.delete(folderId);
        return next;
      });
    },
    [folderSessions, store],
  );

  const updateFolderSessionTitle = useCallback(({ sessionId, title }: { sessionId: string; title: string }) => {
    setFolderSessions(current => {
      let changed = false;
      const next = new Map<string, readonly ChatFolderSession[]>();
      for (const [folderId, sessions] of current) {
        if (sessions.some(session => session.sessionId === sessionId)) {
          changed = true;
          next.set(
            folderId,
            sessions.map(session => (session.sessionId === sessionId ? { ...session, title } : session)),
          );
        } else {
          next.set(folderId, sessions);
        }
      }
      return changed ? next : current;
    });
    setUnfiledSessions(current => {
      if (!current.some(session => session.sessionId === sessionId)) return current;
      return current.map(session => (session.sessionId === sessionId ? { ...session, title } : session));
    });
  }, []);

  const removeFolderSession = useCallback(({ sessionId }: { sessionId: string }) => {
    setFolderSessions(current => {
      let changed = false;
      const next = new Map<string, readonly ChatFolderSession[]>();
      for (const [folderId, sessions] of current) {
        if (sessions.some(session => session.sessionId === sessionId)) {
          changed = true;
          next.set(
            folderId,
            sessions.filter(session => session.sessionId !== sessionId),
          );
        } else {
          next.set(folderId, sessions);
        }
      }
      return changed ? next : current;
    });
    setUnfiledSessions(current => {
      if (!current.some(session => session.sessionId === sessionId)) return current;
      return current.filter(session => session.sessionId !== sessionId);
    });
    setAssignments(current => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

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
    return {
      folders,
      assignments,
      folderSessions,
      unfiledSessions,
      loadError,
      createFolder,
      renameFolder,
      deleteFolder,
      moveChat,
      updateFolderSessionTitle,
      removeFolderSession,
    };
  }, [
    assignments,
    createFolder,
    deleteFolder,
    folderSessions,
    folders,
    loadError,
    moveChat,
    removeFolderSession,
    renameFolder,
    store,
    unfiledSessions,
    updateFolderSessionTitle,
  ]);

  return <ChatFolderContext.Provider value={value}>{children}</ChatFolderContext.Provider>;
}

export function useOptionalChatFolders(): ChatFolderContextValue | null {
  return useContext(ChatFolderContext);
}
