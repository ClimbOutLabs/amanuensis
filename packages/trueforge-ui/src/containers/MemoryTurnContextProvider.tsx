'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import { useAuiState } from '../assistant-ui.js';
import { useOptionalMemoryRecall, type MemoryTurnContext } from '../components/MemoryRecallContext.js';

const EMPTY_MAP: ReadonlyMap<string, MemoryTurnContext> = new Map();

/** How often `MemoryTurnContextProvider` re-reads the session's durable memory context. */
const POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep polling after the thread stops running. Profile learning is launched
 * fire-and-forget right after `turn.done` (`submitProfileLearning` in `apis/turns.ts`) and only
 * appends `aman.profile.learned` once its distillation call and profile write finish; that call
 * is allowed up to 60s (`DISTILLATION_TIMEOUT_MS` in `runtime/profileLearning.ts`). A single
 * refresh made the instant the thread stops can race ahead of that write and miss the profile
 * card until reload, so keep polling past `isRunning` going false for slightly longer than the
 * worst case rather than stopping immediately.
 */
const POST_RUN_POLL_MS = 65_000;

type MemoryTurnContextState = {
  byTurn: ReadonlyMap<string, MemoryTurnContext>;
  /** Whether the most recent refresh attempt failed. Cleared by the next successful refresh. */
  hasError: boolean;
};

const EMPTY_STATE: MemoryTurnContextState = { byTurn: EMPTY_MAP, hasError: false };

const MemoryTurnContextDataContext = createContext<MemoryTurnContextState>(EMPTY_STATE);
const MemoryTurnContextRetryContext = createContext<() => void>(() => {});

/**
 * Fetches this session's memory-recall / learned-profile events once per session (and on an
 * interval while the thread is running — plus a grace period after it stops, see
 * `POST_RUN_POLL_MS` — so a turn's recall/profile shows up without a reload) and makes them
 * available to every assistant message by turn id — each message then does an O(1) lookup instead
 * of re-fetching the whole session's events itself.
 *
 * A refresh already in flight is never abandoned by the next poll tick: overlapping requests are
 * coalesced (at most one more refresh is queued behind the in-flight one) instead of each tick
 * starting a new request and discarding whichever finishes first, so a slow backend still gets its
 * response applied instead of every poll racing to be thrown away.
 *
 * A failed refresh does not clear previously loaded context — best-effort audit surface, so a
 * transient failure should not blank out what already loaded — but it does record `hasError`
 * (see `useMemoryTurnContextStatus`) so the UI can tell "no context this turn" apart from
 * "couldn't check" instead of silently rendering nothing for both (SPEC.md I5).
 *
 * Renders `children` unchanged when no host `MemoryRecallProvider` is mounted, so this is a no-op
 * for hosts that do not expose Amanuensis-style memory recall.
 */
export function MemoryTurnContextProvider({ children }: PropsWithChildren) {
  const api = useOptionalMemoryRecall();
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const isRunning = useThreadIsRunning();
  const [state, setState] = useState<MemoryTurnContextState>(EMPTY_STATE);
  const refreshRef = useRef<() => void>(() => {});
  // Only a running→stopped transition earns the post-run grace period; a session that opens
  // already idle (e.g. a completed session loaded fresh) needs just the one initial refresh.
  const wasRunningRef = useRef(false);

  useEffect(() => {
    wasRunningRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (api == null || sessionId == null) {
      setState(EMPTY_STATE);
      refreshRef.current = () => {};
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let rerunRequested = false;

    const refresh = () => {
      if (cancelled) return;
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      inFlight = true;
      void api
        .listMemoryTurnContext(sessionId)
        .then(items => {
          if (cancelled) return;
          setState({ byTurn: new Map(items.map(item => [item.turnId, item])), hasError: false });
        })
        .catch(() => {
          if (cancelled) return;
          setState(prev => ({ ...prev, hasError: true }));
        })
        .finally(() => {
          inFlight = false;
          if (cancelled) return;
          if (rerunRequested) {
            rerunRequested = false;
            refresh();
          }
        });
    };
    refreshRef.current = refresh;

    // Skip poll ticks while the tab is hidden (matching SentinelAuditFeed) so a hidden tab
    // fires no requests; refresh once immediately when the tab becomes visible again.
    const poll = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();

    if (isRunning) {
      wasRunningRef.current = true;
      const intervalId = setInterval(poll, POLL_INTERVAL_MS);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        cancelled = true;
        clearInterval(intervalId);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }

    if (wasRunningRef.current) {
      // The thread just stopped: keep polling for a bounded grace period rather than only once,
      // since `aman.profile.learned` can legitimately still be on its way (see POST_RUN_POLL_MS).
      wasRunningRef.current = false;
      const intervalId = setInterval(poll, POLL_INTERVAL_MS);
      const stopTimeoutId = setTimeout(() => clearInterval(intervalId), POST_RUN_POLL_MS);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        cancelled = true;
        clearInterval(intervalId);
        clearTimeout(stopTimeoutId);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [api, sessionId, isRunning]);

  const retry = useCallback(() => refreshRef.current(), []);

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
