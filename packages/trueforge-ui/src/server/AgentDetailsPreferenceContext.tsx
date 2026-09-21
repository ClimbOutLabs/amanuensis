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
 * Chat-level "Show agent details" preference, persisted on session metadata
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

  // Reads the latest map off a ref (not the `visibility` closure) so this stays referentially
  // stable across loads instead of forcing every consumer's effect to re-run on each one.
  const ensureLoaded = useCallback(
    (sessionId: string) => {
      if (server == null) return;
      if (visibilityRef.current.has(sessionId) || loadingRef.current.has(sessionId)) return;
      loadingRef.current.add(sessionId);
      void server
        .getSession({ sessionId })
        .then(session => {
          const value = sessionAgentDetails(session) ?? 'collapsed';
          setVisibilityMap(current => new Map(current).set(sessionId, value));
        })
        .catch(() => undefined)
        .finally(() => {
          loadingRef.current.delete(sessionId);
        });
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
 * The chat-level "Show agent details" preference for one session, defaulting to `'collapsed'`
 * until the server value is loaded (or when there is no session yet, e.g. a draft chat).
 */
export function useAgentDetailsVisibility(sessionId: string | undefined): {
  visibility: AgentDetailsVisibility;
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

  return { visibility, setVisibility };
}
