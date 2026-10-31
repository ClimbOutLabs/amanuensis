'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  sessionAgentDetails,
  withSessionAgentDetails,
  type AgentDetailsVisibility,
} from '../atoms/lib/sessionAgentDetails.js';
import { useOptionalServer } from './ServerContext.js';
import type { UpdateSessionRequest } from './types.js';

export type { AgentDetailsVisibility } from '../atoms/lib/sessionAgentDetails.js';

type AgentDetailsPreferenceContextValue = {
  visibility: ReadonlyMap<string, AgentDetailsVisibility>;
  ensureLoaded(sessionId: string): void;
  setVisibility(sessionId: string, value: AgentDetailsVisibility): Promise<void>;
};

const AgentDetailsPreferenceContext = createContext<AgentDetailsPreferenceContextValue | null>(null);

/**
 * Chat-level "Agent details" preference, persisted on session metadata
 * (`agent_details`, see `packages/trueforge/src/schemas/session.ts` `SessionMetadataSchema`
 * and its PATCH `/api/v1/sessions/{id}`). One provider instance shares the cache between the
 * sidebar's per-chat menu and the open thread, so toggling the active chat's own row updates
 * its rendered turns immediately, and a remount re-reads the stored preference from the server.
 */
export function AgentDetailsPreferenceProvider({ children }: { children: ReactNode }) {
  const server = useOptionalServer();
  const [visibility, setVisibilityMap] = useState<ReadonlyMap<string, AgentDetailsVisibility>>(() => new Map());
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;
  const loadingRef = useRef<Set<string>>(new Set());
  const retryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = retryTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Reads the latest map off a ref (not the `visibility` closure) so this stays referentially
  // stable across loads instead of forcing every consumer's effect to re-run on each one.
  const ensureLoaded = useCallback(
    (sessionId: string) => {
      if (server == null) return;
      if (visibilityRef.current.has(sessionId) || loadingRef.current.has(sessionId)) return;
      loadingRef.current.add(sessionId);
      const load = (attempt: number) => {
        server
          .getSession({ sessionId })
          .then(session => {
            loadingRef.current.delete(sessionId);
            const value = sessionAgentDetails(session) ?? 'collapsed';
            // A choice made while this read was in flight is newer than what the read saw.
            setVisibilityMap(current => (current.has(sessionId) ? current : new Map(current).set(sessionId, value)));
          })
          .catch(() => {
            // A failed read must not leave the chat on the default for good: details the person
            // turned on would stay hidden until the page reloads. Retry with a growing pause.
            const timer = setTimeout(
              () => {
                retryTimersRef.current.delete(timer);
                if (visibilityRef.current.has(sessionId)) {
                  loadingRef.current.delete(sessionId);
                  return;
                }
                load(attempt + 1);
              },
              Math.min(1000 * 2 ** attempt, 30_000),
            );
            retryTimersRef.current.add(timer);
          });
      };
      load(0);
    },
    [server],
  );

  const setVisibility = useCallback(
    async (sessionId: string, value: AgentDetailsVisibility) => {
      if (server == null) return;
      setVisibilityMap(current => new Map(current).set(sessionId, value));
      // Metadata is a full replace on the wire; read the session first so we merge instead of
      // dropping other metadata keys (e.g. `is_create_agent`).
      const current = await server.getSession({ sessionId });
      const request: UpdateSessionRequest & { metadata: Record<string, string> } = {
        sessionId,
        metadata: withSessionAgentDetails(current, value),
      };
      await server.updateSession(request);
    },
    [server],
  );

  const value = useMemo<AgentDetailsPreferenceContextValue>(
    () => ({ visibility, ensureLoaded, setVisibility }),
    [visibility, ensureLoaded, setVisibility],
  );

  return <AgentDetailsPreferenceContext.Provider value={value}>{children}</AgentDetailsPreferenceContext.Provider>;
}

/**
 * The chat-level "Agent details" preference for one session, defaulting to `'collapsed'`
 * until the server value is loaded (or when there is no session yet, e.g. a draft chat).
 * `visible` is the one answer to "is agent detail shown"; every renderer reads it from here.
 */
export function useAgentDetailsVisibility(sessionId: string | undefined): {
  visible: boolean;
  setVisibility: (value: AgentDetailsVisibility) => Promise<void>;
} {
  const ctx = useContext(AgentDetailsPreferenceContext);

  useEffect(() => {
    if (sessionId != null) ctx?.ensureLoaded(sessionId);
  }, [ctx, sessionId]);

  const visibility = sessionId == null ? 'collapsed' : (ctx?.visibility.get(sessionId) ?? 'collapsed');
  const setVisibility = useCallback(
    (value: AgentDetailsVisibility) => {
      if (sessionId == null || ctx == null) return Promise.resolve();
      return ctx.setVisibility(sessionId, value);
    },
    [ctx, sessionId],
  );

  return { visible: visibility === 'expanded', setVisibility };
}
