'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuiState } from '../assistant-ui.js';

/** How often the session's durable context is re-read while the thread is running. */
const POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep polling after the thread stops running. Host work launched right after
 * `turn.done` (learned-profile distillation, turn summarization, the usage of that work) appends
 * its events only when it finishes, and profile learning is allowed up to 60s. A single refresh
 * made the instant the thread stops can race ahead of those writes and miss them until reload, so
 * polling continues for slightly longer than the worst case rather than stopping immediately.
 */
const POST_RUN_POLL_MS = 65_000;

type PolledState<T> = {
  data: T | undefined;
  /** Whether the most recent refresh attempt failed. Cleared by the next successful refresh. */
  hasError: boolean;
};

const EMPTY_STATE = { data: undefined, hasError: false } as const;

/**
 * Reads durable per-session context with `load` once per session, then on an interval while the
 * thread is running plus a grace period after it stops (see `POST_RUN_POLL_MS`), so a turn's
 * context shows up without a reload. Shared by every provider that surfaces host-recorded turn
 * events, so they poll one way.
 *
 * A refresh already in flight is never abandoned by the next poll tick: overlapping requests are
 * coalesced (at most one more refresh is queued behind the in-flight one) instead of each tick
 * starting a new request and discarding whichever finishes first, so a slow backend still gets its
 * response applied.
 *
 * A failed refresh does not clear previously loaded data, since these are best-effort audit
 * surfaces, but it does set `hasError` so callers can tell "nothing this turn" from "couldn't check".
 *
 * Does nothing when `load` is undefined or there is no session yet.
 */
export function usePolledSessionContext<T>(load: ((sessionId: string) => Promise<T>) | undefined): {
  data: T | undefined;
  hasError: boolean;
  retry: () => void;
} {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const isRunning = useThreadIsRunning();
  const [state, setState] = useState<PolledState<T>>(EMPTY_STATE);
  const refreshRef = useRef<() => void>(() => {});
  // Only a running to stopped transition earns the post-run grace period; a session that opens
  // already idle (e.g. a completed session loaded fresh) needs just the one initial refresh.
  const wasRunningRef = useRef(false);

  useEffect(() => {
    wasRunningRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (load === undefined || sessionId == null) {
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
      void load(sessionId)
        .then(data => {
          if (cancelled) return;
          setState({ data, hasError: false });
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

    // Skip poll ticks while the tab is hidden so a hidden tab fires no requests; refresh once
    // immediately when the tab becomes visible again.
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
  }, [load, sessionId, isRunning]);

  const retry = useCallback(() => refreshRef.current(), []);

  return { data: state.data, hasError: state.hasError, retry };
}
