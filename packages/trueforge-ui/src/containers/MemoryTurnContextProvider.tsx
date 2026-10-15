'use client';

import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { useOptionalMemoryRecall, type MemoryTurnContext } from '../components/MemoryRecallContext.js';
import { usePolledSessionContext } from '../hooks/usePolledSessionContext.js';

const EMPTY_MAP: ReadonlyMap<string, MemoryTurnContext> = new Map();

type MemoryTurnContextState = {
  byTurn: ReadonlyMap<string, MemoryTurnContext>;
  /** Whether the most recent refresh attempt failed. Cleared by the next successful refresh. */
  hasError: boolean;
};

const EMPTY_STATE: MemoryTurnContextState = { byTurn: EMPTY_MAP, hasError: false };

const MemoryTurnContextDataContext = createContext<MemoryTurnContextState>(EMPTY_STATE);
const MemoryTurnContextRetryContext = createContext<() => void>(() => {});

/**
 * Fetches this session's memory-recall / learned-profile events (polled like every host-recorded
 * turn event, see `usePolledSessionContext`, so a turn's recall/profile shows up without a reload)
 * and makes them available to every assistant message by turn id, so each message does an O(1)
 * lookup instead of re-fetching the whole session's events itself.
 *
 * A failed refresh does not clear previously loaded context, but it does record `hasError`
 * (see `useMemoryTurnContextStatus`) so the UI can tell "no context this turn" apart from
 * "couldn't check" instead of silently rendering nothing for both (SPEC.md I5).
 *
 * Renders `children` unchanged when no host `MemoryRecallProvider` is mounted, so this is a no-op
 * for hosts that do not expose Amanuensis-style memory recall.
 */
export function MemoryTurnContextProvider({ children }: PropsWithChildren) {
  const api = useOptionalMemoryRecall();
  const { data, hasError, retry } = usePolledSessionContext(api?.listMemoryTurnContext);
  const state = useMemo<MemoryTurnContextState>(
    () => ({ byTurn: data === undefined ? EMPTY_MAP : new Map(data.map(item => [item.turnId, item])), hasError }),
    [data, hasError],
  );

  return (
    <MemoryTurnContextDataContext.Provider value={state}>
      <MemoryTurnContextRetryContext.Provider value={retry}>{children}</MemoryTurnContextRetryContext.Provider>
    </MemoryTurnContextDataContext.Provider>
  );
}

export function useMemoryTurnContext(turnId: string | undefined): MemoryTurnContext | undefined {
  const { byTurn } = useContext(MemoryTurnContextDataContext);
  return turnId === undefined ? undefined : byTurn.get(turnId);
}

/**
 * Whether the session's durable memory context is currently known to be missing a refresh, and a
 * way to retry it on demand — for rendering an actionable "context unavailable" state instead of
 * treating a failed fetch the same as "no context happened" (SPEC.md I5).
 */
export function useMemoryTurnContextStatus(): { hasError: boolean; retry: () => void } {
  const { hasError } = useContext(MemoryTurnContextDataContext);
  const retry = useContext(MemoryTurnContextRetryContext);
  return { hasError, retry };
}
