'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';

import { useOptionalComposerBusyState } from './useComposerBusyState.js';

/** What the assistant is doing right now, as read by the avatar. Connectivity stays out:
 *  the rail's status dot already answers "is the backend reachable"; this answers
 *  "what is Aman doing". */
export type AmanAvatarActivity = 'idle' | 'thinking' | 'writing' | 'error';

/** How long a surfaced failure holds the error pose before easing back to whatever the
 *  agent is actually doing (idle, or thinking/writing when a retry is already in flight). */
export const AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS = 4000;

type DerivedActivityInput = {
  /** True while submitting, while the turn stream is active, or while the turn is parked
   *  waiting on the user (tool approval / ask-user / MCP auth). */
  isBusy: boolean;
  /** True while visible response tokens are streaming into chat. */
  isTextStreaming: boolean;
};

type AvatarActivitySink = {
  /** A failure was surfaced to the user (chat runtime onError). Holds the error pose. */
  reportError: () => void;
  /** Ground-truth busy/streaming snapshot from the thread runtime. */
  reportDerived: (input: DerivedActivityInput) => void;
};

const AvatarActivitySinkContext = createContext<AvatarActivitySink | null>(null);

/** Null outside an `AvatarActivityProvider`, so hosts that never wire the callback degrade silently. */
export function useAvatarActivitySink(): AvatarActivitySink | null {
  return useContext(AvatarActivitySinkContext);
}

function deriveActivity({ isBusy, isTextStreaming }: DerivedActivityInput): AmanAvatarActivity {
  if (!isBusy) return 'idle';
  return isTextStreaming ? 'writing' : 'thinking';
}

/**
 * Owns the raw activity ground truth for one chat instance. Mounted by `TrueFoundryChatProvider`
 * above the runtime; `AvatarActivityBridge` (inside the thread tree) and the runtime's
 * `onError` path report into it, and it emits `onActivity` immediately whenever the raw
 * activity changes. Presentation policy (debounce, dwell, thinking-flash skip) lives in
 * `AmanAvatarMotion`, not here.
 */
export function AvatarActivityProvider({
  onActivity,
  children,
}: {
  onActivity?: (activity: AmanAvatarActivity) => void;
  children: ReactNode;
}) {
  const onActivityRef = useRef(onActivity);
  const lastEmittedRef = useRef<AmanAvatarActivity>('idle');
  const lastDerivedRef = useRef<DerivedActivityInput>({ isBusy: false, isTextStreaming: false });
  // Which (callback, activity) pair was last delivered: a (re)subscribed callback that has
  // not heard the current activity gets it immediately instead of waiting for the next
  // transition. This also keeps the initial mount from double-delivering when the bridge's
  // own mount effect (child effects run before the provider's) already reported.
  const deliveredToRef = useRef<{
    callback: ((activity: AmanAvatarActivity) => void) | undefined;
    activity: AmanAvatarActivity;
  } | null>(null);
  const errorArmedRef = useRef(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the subscriber pointer fresh without writing the ref during render.
  useEffect(() => {
    onActivityRef.current = onActivity;
  });

  // A (re)subscribed host gets the current activity immediately instead of waiting for the
  // next transition: covers a provider remount mid-turn above a reused subtree, and any host
  // that attaches its callback late. Idle is delivered too, not skipped: a parent holding a
  // stale non-idle activity from a previous provider instance clears back to idle instead of
  // sticking. For a stable callback this fires exactly once, at mount.
  useEffect(() => {
    const delivered = deliveredToRef.current;
    if (
      delivered !== null &&
      delivered.callback === onActivity &&
      delivered.activity === lastEmittedRef.current
    ) {
      return;
    }
    deliveredToRef.current = { callback: onActivity, activity: lastEmittedRef.current };
    onActivity?.(lastEmittedRef.current);
  }, [onActivity]);

  const emit = useCallback((activity: AmanAvatarActivity) => {
    if (activity === lastEmittedRef.current) return;
    lastEmittedRef.current = activity;
    const callback = onActivityRef.current;
    deliveredToRef.current = { callback, activity };
    callback?.(activity);
  }, []);

  const disarmError = useCallback(() => {
    errorArmedRef.current = false;
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const reportDerived = useCallback(
    (input: DerivedActivityInput) => {
      lastDerivedRef.current = input;
      // A retry already in flight supersedes the error pose: the agent is working again.
      if (errorArmedRef.current && input.isBusy) {
        disarmError();
      }
      const candidate =
        errorArmedRef.current && !input.isBusy ? 'error' : deriveActivity(input);
      emit(candidate);
    },
    [disarmError, emit],
  );

  const reportError = useCallback(() => {
    errorArmedRef.current = true;
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    emit('error');
    // The chat message carries the error content; the avatar only acknowledges, then eases
    // back to whatever the agent is actually doing.
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      errorArmedRef.current = false;
      emit(deriveActivity(lastDerivedRef.current));
    }, AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS);
  }, [emit]);

  const sink = useRef<AvatarActivitySink | null>(null);
  if (sink.current === null) {
    // One-time lazy init: the bridge reads this object from context during its own mount
    // effects, so it must exist by the first render. (The per-render property sync that
    // used to live here now runs in the effect below.)
    sink.current = { reportError, reportDerived };
  }
  // The bridge calls through this object from its own effects; keep its entry points aimed
  // at the latest closures without writing during render.
  useEffect(() => {
    const current = sink.current;
    if (current !== null) {
      current.reportError = reportError;
      current.reportDerived = reportDerived;
    }
  }, [reportError, reportDerived]);

  return <AvatarActivitySinkContext.Provider value={sink.current}>{children}</AvatarActivitySinkContext.Provider>;
}

/** True while the latest assistant message has a text part still streaming. Scans only the
 *  newest assistant message: anything older is history, not visible streaming. */
function selectTextStreaming(state: {
  thread: {
    messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<{ type: string; status?: { type: string } }> }>;
  };
}): boolean {
  const messages = state.thread.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== 'assistant') {
      continue;
    }
    return message.parts.some(part => part.type === 'text' && part.status?.type === 'running');
  }
  return false;
}

/**
 * True while the latest assistant message is parked waiting on the user — a tool approval,
 * an ask-user answer, an MCP authorization, a custom action. The runtime reports
 * `isRunning=false` in that window, so without this the avatar would idle while the turn is
 * still open and blocked on the user. Every pause kind the composer UI distinguishes
 * (approval / ask-user / mcp / custom) lands the message in `requires-action`, which is what
 * this reads; it needs only the plain assistant-ui thread state, so it works wherever the
 * bridge mounts, including hosts without the TrueFoundry runtime providers.
 */
function selectTurnBlockedOnUser(state: {
  thread: { messages: ReadonlyArray<{ role: string; status?: { type: string } }> };
}): boolean {
  const messages = state.thread.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== 'assistant') {
      continue;
    }
    return message.status?.type === 'requires-action';
  }
  return false;
}

/**
 * Reports the thread's raw activity into the nearest `AvatarActivityProvider`. Mounted inside
 * `ComposerBusyProvider` (so the optimistic submit beat is visible before the stream starts)
 * and below the assistant-ui runtime provider. Renders nothing.
 */
export function AvatarActivityBridge() {
  const sink = useAvatarActivitySink();
  const isRunning = useThreadIsRunning();
  const busy = useOptionalComposerBusyState();
  const isTextStreaming = useAuiState(selectTextStreaming);
  // A turn parked on a tool approval / ask-user / MCP auth still counts as busy: the agent
  // is waiting on the user, not done.
  const turnBlockedOnUser = useAuiState(selectTurnBlockedOnUser);
  const isBusy = isRunning || (busy?.isBusy ?? false) || turnBlockedOnUser;

  useEffect(() => {
    sink?.reportDerived({ isBusy, isTextStreaming });
  }, [sink, isBusy, isTextStreaming]);

  return null;
}
