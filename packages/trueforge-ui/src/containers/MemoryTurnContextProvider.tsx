'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

import { useAuiState } from '../assistant-ui.js';
import { useOptionalMemoryRecall, type MemoryTurnContext } from '../components/MemoryRecallContext.js';

/** How often `MemoryTurnContextProvider` asks for memory context newer than what it already has. */
const POLL_INTERVAL_MS = 2_000;

/**
 * How long to keep polling after the thread stops running. Profile learning is launched
 * fire-and-forget right after `turn.done` (`submitProfileLearning` in `apis/turns.ts`) and only
 * appends `aman.profile.learned` once its distillation call and profile write finish; that call
 * is allowed up to 60s (`DISTILLATION_TIMEOUT_MS` in `runtime/profileLearning.ts`). The window is
 * kept at that worst case because each poll only asks for newer recall/profile events, so an idle
 * poll returns no rows and renders nothing; polling stops early once the finished turn's profile
 * arrives.
 */
const POST_RUN_POLL_MS = 65_000;

/**
 * Durable memory context by turn, with change notification so each assistant message re-renders
 * only when its own turn's entry changes and a poll that finds nothing new renders nothing.
 */
class MemoryTurnContextStore {
  private byTurn = new Map<string, MemoryTurnContext>();
  private hasError = false;
  private latestEventId: string | undefined;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getHasError = (): boolean => this.hasError;

  getTurn(turnId: string): MemoryTurnContext | undefined {
    return this.byTurn.get(turnId);
  }

  /** Newest recall/profile event id held, the cursor for the next incremental fetch. */
  getLatestEventId(): string | undefined {
    return this.latestEventId;
  }

  /**
   * Folds fetched entries in, keeping each unchanged entry's identity. Only a full read clears
   * a recorded error: an incremental read cannot fill the gap a failed full read left, so it
   * must not clear the error flag.
   */
  merge(items: readonly MemoryTurnContext[], scope: RefreshScope): void {
    const fullRead = scope === 'all';
    let changed = fullRead && this.hasError;
    if (fullRead) {
      this.hasError = false;
    }
    for (const item of items) {
      const existing = this.byTurn.get(item.turnId);
      const recall = item.recall ?? existing?.recall;
      const profile = item.profile ?? existing?.profile;
      this.advanceCursor(recall?.id);
      this.advanceCursor(profile?.id);
      if (existing !== undefined && existing.recall?.id === recall?.id && existing.profile?.id === profile?.id) {
        continue;
      }
      this.byTurn.set(item.turnId, {
        turnId: item.turnId,
        ...(recall === undefined ? {} : { recall }),
        ...(profile === undefined ? {} : { profile }),
      });
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  /** Records a failed refresh without dropping what already loaded. */
  fail(): void {
    if (!this.hasError) {
      this.hasError = true;
      this.emit();
    }
  }

  reset(): void {
    this.latestEventId = undefined;
    if (this.byTurn.size > 0 || this.hasError) {
      this.byTurn = new Map();
      this.hasError = false;
      this.emit();
    }
  }

  private advanceCursor(eventId: string | undefined): void {
    if (eventId !== undefined && (this.latestEventId === undefined || eventId > this.latestEventId)) {
      this.latestEventId = eventId;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

type MemoryTurnContextValue = { store: MemoryTurnContextStore; retry: () => void };

/**
 * `newer` reads past the newest event id held; `all` re-reads the whole filtered history. The
 * cursor follows event creation order, not save order, so an event saved after a newer one (a
 * learned profile landing after the next turn's recall) can sit behind it until an `all` read.
 */
type RefreshScope = 'newer' | 'all';

const EMPTY_VALUE: MemoryTurnContextValue = { store: new MemoryTurnContextStore(), retry: () => {} };

const MemoryTurnContextContext = createContext<MemoryTurnContextValue>(EMPTY_VALUE);

/** The turn id the runtime stamped on the newest assistant message, if any. */
function latestAssistantTurnId(
  messages: readonly { role: string; metadata: { custom: Record<string, unknown> } }[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      const turnId = message.metadata.custom['turnId'];
      return typeof turnId === 'string' ? turnId : undefined;
    }
  }
  return undefined;
}

/**
 * Loads this session's memory-recall / learned-profile events once per session, then polls for
 * newer ones while the thread is running and for a grace period after it stops (see
 * `POST_RUN_POLL_MS`), so a turn's recall/profile shows up without a reload. Each assistant
 * message reads its own turn's entry through `useMemoryTurnContext`, an O(1) lookup that only
 * re-renders that message when its entry changes.
 *
 * Polls are incremental (only events newer than the newest one held) and pause while the page is
 * hidden. Showing the page again and the end of the grace period each re-read the whole filtered
 * history once (see `RefreshScope`); unchanged entries keep their identity, so that renders nothing
 * new. Polling in the grace period stops early once the newest turn's profile event arrives, but
 * the closing full read still happens.
 *
 * A refresh already in flight is never abandoned by the next poll tick: overlapping requests are
 * coalesced (at most one more refresh is queued behind the in-flight one) instead of each tick
 * starting a new request and discarding whichever finishes first.
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
  const latestTurnId = useAuiState(state => latestAssistantTurnId(state.thread.messages));
  const isRunning = useThreadIsRunning();
  const [store] = useState(() => new MemoryTurnContextStore());
  const refreshRef = useRef<(scope: RefreshScope) => void>(() => {});
  const [inGracePeriod, setInGracePeriod] = useState(false);
  // Only a running→stopped transition earns the grace period; a session that opens already idle
  // (e.g. a completed session loaded fresh) needs just the one initial load.
  const wasRunningRef = useRef(false);
  const latestTurnHasProfile = useSyncExternalStore(
    store.subscribe,
    () => latestTurnId !== undefined && store.getTurn(latestTurnId)?.profile !== undefined,
  );

  useEffect(() => {
    if (api == null || sessionId == null) {
      store.reset();
      refreshRef.current = () => {};
      return;
    }

    store.reset();
    let cancelled = false;
    let inFlight = false;
    let rerun: RefreshScope | undefined;

    const refresh = (scope: RefreshScope) => {
      if (cancelled) return;
      if (inFlight) {
        rerun = rerun === 'all' ? 'all' : scope;
        return;
      }
      inFlight = true;
      const afterEventId = scope === 'all' ? undefined : store.getLatestEventId();
      void api
        .listMemoryTurnContext(sessionId, afterEventId === undefined ? undefined : { afterEventId })
        .then(items => {
          if (!cancelled) store.merge(items, scope);
        })
        .catch(() => {
          if (!cancelled) store.fail();
        })
        .finally(() => {
          inFlight = false;
          if (cancelled || rerun === undefined) return;
          const next = rerun;
          rerun = undefined;
          refresh(next);
        });
    };
    refreshRef.current = refresh;
    refresh('all');

    return () => {
      cancelled = true;
      refreshRef.current = () => {};
    };
  }, [api, sessionId, store]);

  useEffect(() => {
    wasRunningRef.current = false;
    setInGracePeriod(false);
  }, [sessionId]);

  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true;
      setInGracePeriod(false);
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;
    setInGracePeriod(true);
  }, [isRunning]);

  // Owned by the grace state so a new run or a session switch cancels it along with the state.
  useEffect(() => {
    if (!inGracePeriod) return;
    const timeoutId = setTimeout(() => {
      setInGracePeriod(false);
      // One last full read picks up a profile saved behind the cursor; a hidden page does it on show.
      if (document.visibilityState === 'visible') refreshRef.current('all');
    }, POST_RUN_POLL_MS);
    return () => clearTimeout(timeoutId);
  }, [inGracePeriod]);

  const shouldPoll = api != null && sessionId != null && (isRunning || (inGracePeriod && !latestTurnHasProfile));

  // Skip poll ticks while the tab is hidden (matching SentinelAuditFeed) so a hidden tab
  // fires no requests.
  useEffect(() => {
    if (!shouldPoll) return;
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRef.current('newer');
    }, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [shouldPoll]);

  // Showing the page again catches up at once with a full read: a hidden tab skips polls and may
  // have outlived the grace period that would have picked up a late profile write.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshRef.current('all');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // The read that failed may have been a full one, so a retry re-reads everything.
  const retry = useCallback(() => refreshRef.current('all'), []);
  const value = useMemo(() => ({ store, retry }), [store, retry]);

  return <MemoryTurnContextContext.Provider value={value}>{children}</MemoryTurnContextContext.Provider>;
}

export function useMemoryTurnContext(turnId: string | undefined): MemoryTurnContext | undefined {
  const { store } = useContext(MemoryTurnContextContext);
  return useSyncExternalStore(store.subscribe, () => (turnId === undefined ? undefined : store.getTurn(turnId)));
}

/**
 * Whether the session's durable memory context is currently known to be missing a refresh, and a
 * way to retry it on demand — for rendering an actionable "context unavailable" state instead of
 * treating a failed fetch the same as "no context happened" (SPEC.md I5).
 */
export function useMemoryTurnContextStatus(): { hasError: boolean; retry: () => void } {
  const { store, retry } = useContext(MemoryTurnContextContext);
  const hasError = useSyncExternalStore(store.subscribe, store.getHasError);
  return { hasError, retry };
}
