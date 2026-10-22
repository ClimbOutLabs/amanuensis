'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import type { ReactNode } from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useToasterOptional } from '../containers/ToasterContainer.js';
import {
  APPROVAL_AUTO_DENY_MINUTES,
  approvalAutoDenyReason,
  subscribeToBlockedSend,
  type HarnessChatServerExtensions,
  type SessionTipInfo,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { isStaleApprovalError, subscribeToStaleApproval } from '../utils/staleApproval.js';

/**
 * Structural check: the trueforge adapter attaches the session-resync port
 * next to the runtime's `AgentChatServer` surface; other servers don't carry
 * it. A foreign server simply disables the foreground sync.
 */
function hasSessionResync(server: object): server is HarnessChatServerExtensions {
  const peek: unknown = Reflect.get(server, 'peekSessionTip');
  const dismiss: unknown = Reflect.get(server, 'dismissPendingApprovals');
  return typeof peek === 'function' && typeof dismiss === 'function';
}

/** `focus` and `visibilitychange` fire together; coalesce them into one sync. */
const FOREGROUND_SYNC_DEBOUNCE_MS = 500;
/** Only re-sync when the page was hidden long enough for something to have happened. */
const FOREGROUND_SYNC_MIN_HIDDEN_MS = 30_000;
/**
 * A phone can kill a running reply's stream within seconds of hiding the page and leave it
 * looking open, and the server sends no heartbeat that would show it is dead. So a running
 * reply is re-checked after a much shorter hide.
 */
const RUNNING_REPLY_MIN_HIDDEN_MS = 5_000;
/** Visible time spent reconnecting before the chat asks the person to check their network. */
export const RECONNECT_GIVE_UP_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 8_000;

export type ChatConnectionStatus = 'connected' | 'reconnecting' | 'lost';

export type ChatConnection = {
  status: ChatConnectionStatus;
  /** Try to reach the server again now and resync the chat. */
  retry: () => void;
};

const ChatConnectionContext = createContext<ChatConnection>({ status: 'connected', retry: () => undefined });

/** Live connection state of the chat this component renders in. */
export function useChatConnection(): ChatConnection {
  return useContext(ChatConnectionContext);
}

/**
 * Per-chat signal that a reply's live stream was lost for good. The chat
 * provider reports here (it sits outside the runtime) so the sync below can
 * reconnect and resync instead of the drop showing up as an error.
 */
export type StreamDropChannel = {
  report: () => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStreamDropChannel(): StreamDropChannel {
  const listeners = new Set<() => void>();
  return {
    report: () => {
      for (const listener of listeners) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type SyncPorts = {
  server: object | null;
  reload: () => void;
  toaster: ReturnType<typeof useToasterOptional>;
  sessionId: string | null | undefined;
  isRunning: boolean;
};

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

/**
 * One chat's sync and connection recovery. A cheap tip probe decides whether
 * an idle foreground needs a reload; once the server could not be reached
 * (a dropped reply stream, a failed probe, a page restored from the
 * back-forward cache) the chat owes a full resync, retried with capped
 * backoff while the page is visible and run as soon as the server answers.
 */
function createChatSync({
  readPorts,
  setStatus,
}: {
  readPorts: () => SyncPorts;
  setStatus: (status: ChatConnectionStatus) => void;
}) {
  let syncInFlight = false;
  let lastTip: string | undefined;
  let resyncOwed = false;
  let lost = false;
  let failedAttempts = 0;
  let windowOpen = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
    retryTimer = undefined;
    giveUpTimer = undefined;
  };

  // Only visible time counts toward giving up: a phone in a pocket is not a failed reconnect.
  const openWindow = () => {
    if (windowOpen || isPageHidden()) return;
    windowOpen = true;
    giveUpTimer = setTimeout(() => {
      giveUpTimer = undefined;
      if (!resyncOwed) return;
      lost = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      setStatus('lost');
    }, RECONNECT_GIVE_UP_MS);
  };

  const beginRecovery = () => {
    if (resyncOwed) return;
    resyncOwed = true;
    lost = false;
    failedAttempts = 0;
    setStatus('reconnecting');
    openWindow();
  };

  const endRecovery = () => {
    resyncOwed = false;
    lost = false;
    failedAttempts = 0;
    windowOpen = false;
    clearTimers();
    setStatus('connected');
  };

  const handleTip = async (tip: SessionTipInfo, sessionId: string, ports: SyncPorts) => {
    const { server, reload, toaster } = ports;
    if (tip.pendingApprovals.length > 0) {
      const oldestMs = Math.min(...tip.pendingApprovals.map(approval => Date.parse(approval.createdAt)));
      if (
        server != null &&
        hasSessionResync(server) &&
        Number.isFinite(oldestMs) &&
        Date.now() - oldestMs > APPROVAL_AUTO_DENY_MINUTES * 60_000
      ) {
        const result = await server
          .dismissPendingApprovals({ sessionId, reason: approvalAutoDenyReason() })
          .catch((error: unknown) => {
            // The chat moved on while we looked; nothing to deny. A background cleanup
            // must not surface an error the user did not cause.
            if (isStaleApprovalError(error)) return { dismissed: 0, alreadyResolved: true };
            throw error;
          });
        if (!result.alreadyResolved) {
          const plural = result.dismissed === 1 ? '' : 's';
          toaster?.showSuccess({
            title: 'Expired approvals denied',
            description:
              `${result.dismissed} tool approval${plural} went unanswered for ` +
              `${APPROVAL_AUTO_DENY_MINUTES} minutes and ` +
              `${result.dismissed === 1 ? 'was' : 'were'} automatically denied.`,
          });
        }
      }
      // Surface the approval card (or the turn the decision started) even
      // when nothing was old enough to auto-deny.
      reload();
    } else if (tip.status === 'running' || (lastTip !== undefined && tip.turnId !== lastTip)) {
      // A reply still running may have lost its stream without an error while the page slept.
      reload();
    }
    lastTip = tip.turnId;
  };

  const sync = () => {
    if (syncInFlight || isPageHidden()) return;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const ports = readPorts();
    const { server, sessionId } = ports;
    syncInFlight = true;
    void (async () => {
      try {
        let tip: SessionTipInfo | null = null;
        try {
          if (server != null && hasSessionResync(server) && sessionId != null) {
            tip = await server.peekSessionTip({ sessionId });
          }
        } catch {
          beginRecovery();
          failedAttempts += 1;
          if (!lost && !isPageHidden()) {
            const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (failedAttempts - 1), RECONNECT_MAX_DELAY_MS);
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              sync();
            }, delayMs);
          }
          return;
        }
        if (resyncOwed) {
          // The server answered: rebuild the chat from it. A full reload replaces what is on
          // screen, so a reply still running resumes once and pending approvals come back.
          endRecovery();
          lastTip = tip?.turnId;
          ports.reload();
          return;
        }
        if (tip != null && sessionId != null) await handleTip(tip, sessionId, ports);
      } catch (error) {
        ports.toaster?.showError(error instanceof Error ? error : new Error('Could not reach the chat server.'));
      } finally {
        syncInFlight = false;
      }
    })();
  };

  return {
    sync,
    /** The live streams are gone (a dropped reply, a page restored from cache): reconnect and resync. */
    resync: () => {
      beginRecovery();
      sync();
    },
    hidden: () => {
      clearTimers();
      windowOpen = false;
    },
    /** True when the page came back while a resync is owed. */
    visible: (): boolean => {
      if (!resyncOwed) return false;
      openWindow();
      return true;
    },
    retry: () => {
      if (resyncOwed) {
        lost = false;
        failedAttempts = 0;
        windowOpen = false;
        clearTimers();
        setStatus('reconnecting');
        openWindow();
      } else {
        beginRecovery();
      }
      sync();
    },
    dispose: clearTimers,
  };
}

/**
 * Wires chat lifecycle events to the sync above and provides the chat's
 * connection state to `useChatConnection`. Mount once inside the agent
 * runtime provider, around the chat.
 */
export function ForegroundEventSync({
  streamDrops,
  children,
}: {
  streamDrops?: StreamDropChannel;
  children?: ReactNode;
}): ReactNode {
  const server = useOptionalServer();
  const reload = useTrueFoundryReload();
  const toaster = useToasterOptional();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  const isRunning = useAuiState(state => state.thread.isRunning);
  const [status, setStatus] = useState<ChatConnectionStatus>('connected');

  const liveRef = useRef<SyncPorts>({ server, reload, toaster, sessionId, isRunning });
  liveRef.current = { server, reload, toaster, sessionId, isRunning };
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const chatSync = createChatSync({ readPorts: () => liveRef.current, setStatus });
    retryRef.current = chatSync.retry;
    let debounceId: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;

    const scheduleSync = () => {
      if (debounceId !== undefined) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        debounceId = undefined;
        chatSync.sync();
      }, FOREGROUND_SYNC_DEBOUNCE_MS);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        chatSync.hidden();
        return;
      }
      const hiddenForMs = hiddenAt == null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      const minHiddenMs = liveRef.current.isRunning ? RUNNING_REPLY_MIN_HIDDEN_MS : FOREGROUND_SYNC_MIN_HIDDEN_MS;
      if (chatSync.visible() || hiddenForMs >= minHiddenMs) scheduleSync();
    };
    // Some mobile browsers deliver focus without visibilitychange; treat a
    // focus after a recorded hide the same way.
    const onFocus = () => {
      if (hiddenAt != null && !document.hidden) {
        hiddenAt = null;
        chatSync.visible();
        scheduleSync();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) chatSync.resync();
    };
    const onOnline = () => chatSync.sync();
    const onBlockedSend = () => chatSync.sync();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    const unsubscribeBlockedSend = subscribeToBlockedSend(onBlockedSend);
    const unsubscribeStaleApproval = subscribeToStaleApproval(() => liveRef.current.reload());
    const unsubscribeStreamDrops = streamDrops?.subscribe(chatSync.resync);
    return () => {
      unsubscribeStreamDrops?.();
      unsubscribeStaleApproval();
      unsubscribeBlockedSend();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      if (debounceId !== undefined) clearTimeout(debounceId);
      chatSync.dispose();
      retryRef.current = () => undefined;
    };
  }, [streamDrops]);

  const retry = useCallback(() => retryRef.current(), []);
  const connection = useMemo((): ChatConnection => ({ status, retry }), [status, retry]);
  return createElement(ChatConnectionContext.Provider, { value: connection }, children);
}
