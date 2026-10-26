'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  readTurnedOffConnectorKeys,
  withTurnedOffConnectorKeys,
} from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';

import { sessionMetadataRecord } from '../atoms/lib/sessionAgentDetails.js';
import { useOptionalServer } from './ServerContext.js';
import type { AgentUIServer, UpdateSessionRequest } from './types.js';

const NO_KEYS: readonly string[] = [];

/**
 * The off keys (connectorOffKey) of the connectors turned off per chat, shared by the
 * composer and the shell. A chat that has no server session yet keeps its choice as
 * pending, and the shell sends it with the session create.
 */
export type ChatConnectorChoiceStore = {
  get(sessionId: string | undefined): readonly string[] | undefined;
  set(input: { sessionId: string | undefined; keys: readonly string[] }): void;
  /** Gives the pending choice of a new chat to the session that was just created for it. */
  adoptPending(sessionId: string): void;
  clearPending(): void;
  subscribe(listener: () => void): () => void;
  version(): number;
};

export function createChatConnectorChoiceStore(): ChatConnectorChoiceStore {
  const bySession = new Map<string, readonly string[]>();
  const listeners = new Set<() => void>();
  let pending: readonly string[] = NO_KEYS;
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    get: sessionId => (sessionId === undefined ? pending : bySession.get(sessionId)),
    set: ({ sessionId, keys }) => {
      if (sessionId === undefined) {
        pending = keys;
      } else {
        bySession.set(sessionId, keys);
      }
      changed();
    },
    adoptPending: sessionId => {
      bySession.set(sessionId, pending);
      pending = NO_KEYS;
      changed();
    },
    clearPending: () => {
      if (pending.length === 0) return;
      pending = NO_KEYS;
      changed();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

/**
 * The session create with the new chat's off choice in its metadata, so the very first turn
 * already honours it. Once the session exists the choice belongs to it, not to the next new chat.
 */
export async function createSessionWithConnectorChoice({
  server,
  store,
  metadata,
  request,
}: {
  server: Pick<AgentUIServer, 'createSession'>;
  store: ChatConnectorChoiceStore | null;
  metadata: Record<string, string>;
  request: Parameters<AgentUIServer['createSession']>[0];
}): ReturnType<AgentUIServer['createSession']> {
  const withMetadata: Parameters<AgentUIServer['createSession']>[0] & { metadata: Record<string, string> } = {
    ...request,
    metadata: withTurnedOffConnectorKeys(metadata, store?.get(undefined) ?? NO_KEYS),
  };
  const session = await server.createSession(withMetadata);
  store?.adoptPending(session.id);
  return session;
}

const ChatConnectorChoiceContext = createContext<ChatConnectorChoiceStore | null>(null);

export function ChatConnectorChoiceProvider({
  store,
  children,
}: {
  store: ChatConnectorChoiceStore;
  children: ReactNode;
}) {
  return <ChatConnectorChoiceContext.Provider value={store}>{children}</ChatConnectorChoiceContext.Provider>;
}

/** The shared store, for the shell that creates sessions; null outside a provider. */
export function useChatConnectorChoiceStore(): ChatConnectorChoiceStore | null {
  return useContext(ChatConnectorChoiceContext);
}

/**
 * The connectors turned off for one chat, kept on the chat's session metadata so the choice
 * survives a reload. With no session yet (a new chat) the choice waits in the store. A failed
 * write puts the previous choice back, so the screen never shows more than the server holds.
 */
export function useChatConnectorChoice(sessionId: string | undefined): {
  turnedOff: readonly string[];
  setTurnedOff: (keys: readonly string[]) => Promise<void>;
} {
  const server = useOptionalServer();
  const shared = useContext(ChatConnectorChoiceContext);
  const [local] = useState(createChatConnectorChoiceStore);
  const store = shared ?? local;
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const known = store.get(sessionId);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const loading = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (server == null || sessionId === undefined || known !== undefined || loading.current.has(sessionId)) return;
    loading.current.add(sessionId);
    server
      .getSession({ sessionId })
      .then(session => {
        // A choice made while this read was in flight is newer than what the read saw.
        if (store.get(sessionId) === undefined) {
          store.set({ sessionId, keys: readTurnedOffConnectorKeys(sessionMetadataRecord(session)) });
        }
      })
      .catch(() => {
        // The chat keeps the default, which is on, until the next time it is opened.
        loading.current.delete(sessionId);
      });
  }, [server, sessionId, known, store]);

  const setTurnedOff = useCallback(
    (keys: readonly string[]) => {
      const previous = store.get(sessionId) ?? NO_KEYS;
      store.set({ sessionId, keys });
      if (server == null || sessionId === undefined) return Promise.resolve();
      const write = writes.current
        .catch(() => undefined)
        .then(async () => {
          // Metadata is a full replace on the wire; read the session first so other keys stay.
          const current = await server.getSession({ sessionId });
          const request: UpdateSessionRequest & { metadata: Record<string, string> } = {
            sessionId,
            metadata: withTurnedOffConnectorKeys(sessionMetadataRecord(current), keys),
          };
          await server.updateSession(request);
        })
        .catch((error: unknown) => {
          store.set({ sessionId, keys: previous });
          throw error;
        });
      writes.current = write;
      return write;
    },
    [server, sessionId, store],
  );

  return { turnedOff: known ?? NO_KEYS, setTurnedOff };
}
