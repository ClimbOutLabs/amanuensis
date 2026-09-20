'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ComposerBusyState = {
  /** True while submitting or while the turn stream is active. */
  isBusy: boolean;
  isRunning: boolean;
  isSubmitting: boolean;
  /** The thread the latest send was dispatched on (its `threadListItem.id`), or null before any
   *  send. Meaningful while `isSubmitting`: a caller looking at another thread in the same chat
   *  view can tell that the pending attempt is not that thread's. */
  sendThreadId: string | null;
  /** Returns the id assigned to this attempt, for a caller that can pass it back to
   *  `notifyComposerBusyFailure` to identify which send a later failure belongs to. */
  send: (sendFn: () => void | Promise<void>) => number;
  resetBusy: () => void;
};

const ComposerBusyContext = createContext<ComposerBusyState | null>(null);

/**
 * Identifies one chat runtime's own busy-state world. `TrueFoundryChatProvider` mounts a new
 * `ComposerBusyScopeProvider` per chat instance (see `ComposerBusyScopeProvider` below); every
 * `useComposerBusyState()` inside that subtree, and every `notifyComposerBusyFailure` /
 * `getActiveComposerSendId` call made with that same scope, is isolated to it. Two chats
 * rendered side by side get two distinct scopes, so an id or a failure that belongs to one can
 * never be read or broadcast against the other. The default scope (used when no
 * `ComposerBusyScopeProvider` wraps the tree, e.g. a bare `<ComposerBusyProvider>` in a test)
 * keeps prior single-chat behavior.
 */
export type ComposerBusyScope = symbol;
const DEFAULT_COMPOSER_BUSY_SCOPE: ComposerBusyScope = Symbol('default-composer-busy-scope');
const ComposerBusyScopeContext = createContext<ComposerBusyScope>(DEFAULT_COMPOSER_BUSY_SCOPE);

/**
 * Establishes a fresh, private busy-state scope for everything rendered beneath it: one call
 * site, one scope, for the lifetime of this component instance. Wrap each independent chat
 * runtime in its own `ComposerBusyScopeProvider` (above its `ComposerBusyProvider`) so a send
 * id, a failure notification, or `getActiveComposerSendId()` from one chat can never be read by,
 * or broadcast to, another.
 */
export function ComposerBusyScopeProvider({ children }: { children: ReactNode }) {
  const scope = useRef<ComposerBusyScope | null>(null);
  if (scope.current === null) {
    scope.current = Symbol('composer-busy-scope');
  }
  return createElement(ComposerBusyScopeContext.Provider, { value: scope.current }, children);
}

/** The busy-state scope the calling component is rendered under: the nearest
 *  `ComposerBusyScopeProvider`, or the shared default scope if none wraps it. A caller outside
 *  any `ComposerBusyProvider` subtree (e.g. a chat runtime's own `onError`, above it) can still
 *  read this as long as it too sits inside the matching `ComposerBusyScopeProvider`, so it can
 *  pass the right scope to `notifyComposerBusyFailure` / `getActiveComposerSendId`. */
export function useComposerBusyScope(): ComposerBusyScope {
  return useContext(ComposerBusyScopeContext);
}

/**
 * `aui.composer().send()` returns void and swallows `onNew` rejections, so the
 * optimistic submitting flag cannot clear via Promise.catch. First-message
 * failures (e.g. createSession) also never flip `useThreadIsRunning()`. Chat
 * runtime `onError` calls this so the Cancel/spinner state does not stick.
 *
 * `id`, when given, must match the attempt id returned by `send()`; a failure tagged with an id
 * that is no longer the active attempt (already superseded by a resend) is stale and is ignored,
 * so it cannot clear a newer send's busy state out from under it. Callers with no way to know
 * which attempt failed (the runtime's `onError` has no such id to give) omit it, and the failure
 * still clears unconditionally, exactly as before.
 *
 * `scope` restricts the broadcast to listeners registered under that same `ComposerBusyScope`
 * (see `useComposerBusyScope`); omitted, it targets the shared default scope, so a caller with no
 * scope of its own (an un-migrated host, or a test using `ComposerBusyProvider` directly) keeps
 * working exactly as before.
 */
const busyFailureListenersByScope = new Map<ComposerBusyScope, Set<(id?: number) => void>>();

export function notifyComposerBusyFailure(id?: number, scope: ComposerBusyScope = DEFAULT_COMPOSER_BUSY_SCOPE): void {
  const listeners = busyFailureListenersByScope.get(scope);
  if (listeners === undefined) {
    return;
  }
  for (const listener of listeners) {
    listener(id);
  }
}

/**
 * The id of the most recent send dispatched by any `useComposerBusyState` instance sharing
 * `scope`. Module-level, keyed by scope rather than a single shared value, because a call site
 * that fires before or outside its own `ComposerBusyProvider` subtree (the runtime's `onError`,
 * wired above it) has no other way to learn "which attempt is current for THIS chat" to stamp
 * onto a failure it reports with no id of its own; keying by scope is what keeps that lookup from
 * ever returning an id that belongs to a different chat instance.
 */
const latestSendIdByScope = new Map<ComposerBusyScope, number>();

/** The id of the latest dispatched send within `scope` (the shared default scope if omitted),
 *  for a caller with no attempt id of its own to give `notifyComposerBusyFailure` (the runtime's
 *  `onError`, for example) so a failure it reports is attributed to the newest attempt in ITS OWN
 *  chat instead of clearing busy state unconditionally, or clearing some other chat's. */
export function getActiveComposerSendId(scope: ComposerBusyScope = DEFAULT_COMPOSER_BUSY_SCOPE): number | undefined {
  return latestSendIdByScope.get(scope);
}

function useComposerBusyStateValue(): ComposerBusyState {
  const scope = useContext(ComposerBusyScopeContext);
  const isRunning = useThreadIsRunning();
  const messageCount = useAuiState(state => state.thread.messages.length);
  const lastMessageRole = useAuiState(state => state.thread.messages[state.thread.messages.length - 1]?.role);
  const threadId = useAuiState(state => state.threadListItem.id);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sendThreadId, setSendThreadId] = useState<string | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const nextIdRef = useRef(0);
  /** The thread the active attempt was sent on and its length then; another thread's messages say nothing about it. */
  const sendOriginRef = useRef<{ threadId: string; messageCount: number } | null>(null);

  useEffect(() => {
    if (!isRunning) {
      setIsSubmitting(false);
    }
  }, [isRunning]);

  // A reply that lands without the running flag ever flipping (a backend whose stream signal
  // never surfaces, or a turn that completes between two renders) still ends the attempt: the
  // thread grew past its length at send and now ends in an assistant message. A grown thread that
  // still ends in the user's own message is only the optimistic echo of the send, not a reply.
  // Only the thread the attempt was sent on counts: switching to a longer thread proves nothing.
  useEffect(() => {
    const origin = sendOriginRef.current;
    if (
      isSubmitting &&
      !isRunning &&
      origin !== null &&
      origin.threadId === threadId &&
      lastMessageRole === 'assistant' &&
      messageCount > origin.messageCount
    ) {
      setIsSubmitting(false);
    }
  }, [isRunning, isSubmitting, lastMessageRole, messageCount, threadId]);

  useEffect(() => {
    const clearSubmitting = (id?: number) => {
      if (id !== undefined && id !== activeIdRef.current) {
        // Stale: this failure names an attempt a later send has already replaced.
        return;
      }
      setIsSubmitting(false);
    };
    let listeners = busyFailureListenersByScope.get(scope);
    if (listeners === undefined) {
      listeners = new Set();
      busyFailureListenersByScope.set(scope, listeners);
    }
    listeners.add(clearSubmitting);
    return () => {
      listeners.delete(clearSubmitting);
      if (listeners.size === 0) {
        busyFailureListenersByScope.delete(scope);
      }
    };
  }, [scope]);

  const isBusy = isRunning || isSubmitting;

  const resetBusy = useCallback(() => {
    setIsSubmitting(false);
  }, []);

  const send = useCallback(
    (sendFn: () => void | Promise<void>) => {
      const id = nextIdRef.current + 1;
      nextIdRef.current = id;
      activeIdRef.current = id;
      latestSendIdByScope.set(scope, id);
      sendOriginRef.current = { threadId, messageCount };
      setSendThreadId(threadId);
      setIsSubmitting(true);
      try {
        const result = sendFn();
        if (result != null && typeof result.then === 'function') {
          void result.catch(() => {
            if (activeIdRef.current === id) {
              setIsSubmitting(false);
            }
          });
        }
      } catch {
        if (activeIdRef.current === id) {
          setIsSubmitting(false);
        }
      }
      return id;
    },
    [messageCount, scope, threadId],
  );

  return { isBusy, isRunning, isSubmitting, sendThreadId, send, resetBusy };
}

export function ComposerBusyProvider({ children }: { children: ReactNode }) {
  const value = useComposerBusyStateValue();
  return createElement(ComposerBusyContext.Provider, { value }, children);
}

/**
 * Optimistic composer busy state shared across the thread. `useThreadIsRunning()`
 * only becomes true once the turn stream starts; this hook flips to busy
 * immediately on submit so the send button shows loading before session setup /
 * turn API work finishes.
 *
 * Must be used within `<ComposerBusyProvider>` (wired by default in `<Thread />`).
 */
export function useComposerBusyState(): ComposerBusyState {
  const value = useContext(ComposerBusyContext);
  if (value == null) {
    throw new Error('useComposerBusyState must be used within ComposerBusyProvider');
  }
  return value;
}

/**
 * Optional variant of `useComposerBusyState` that returns null when not within
 * a `ComposerBusyProvider`, allowing graceful degradation.
 */
export function useOptionalComposerBusyState(): ComposerBusyState | null {
  return useContext(ComposerBusyContext);
}
