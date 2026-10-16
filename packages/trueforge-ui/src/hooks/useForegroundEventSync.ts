'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useRef } from 'react';

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
/** Bounded retries so a foreground probe survives a slow wake-from-sleep network. */
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * One cheap `listTurns(limit: 1)` read with capped exponential backoff. Throws
 * the last error when every attempt fails so the caller can report it once.
 */
async function probeWithRetry(
  peekSessionTip: (request: { sessionId: string }) => Promise<SessionTipInfo | null>,
  sessionId: string,
): Promise<SessionTipInfo | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await peekSessionTip({ sessionId });
    } catch (error) {
      lastError = error;
      if (attempt < PROBE_MAX_ATTEMPTS) {
        await sleep(PROBE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

export type SessionEventSyncReason = 'foreground' | 'blocked-send';

/**
 * Delta sync for chat lifecycle events. Probes only the session tip turn;
 * a full reload happens only when the tip moved or carries pending approvals,
 * so an idle background/foreground cycle costs one tiny read and no reload.
 *
 * Pending approvals older than `APPROVAL_AUTO_DENY_MINUTES` are denied
 * automatically (fail-closed) using the persisted approval event timestamp,
 * which keeps working while the browser was backgrounded or closed.
 */
export function useSessionEventSync(): {
  syncNow: (reason: SessionEventSyncReason) => void;
} {
  const server = useOptionalServer();
  const reload = useTrueFoundryReload();
  const toaster = useToasterOptional();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);

  const liveRef = useRef({ server, reload, toaster, sessionId });
  liveRef.current = { server, reload, toaster, sessionId };
  const syncInFlightRef = useRef(false);
  const lastTipRef = useRef<string | undefined>(undefined);

  const syncNow = useCallback((_reason: SessionEventSyncReason) => {
    const {
      server: currentServer,
      reload: currentReload,
      toaster: currentToaster,
      sessionId: currentSessionId,
    } = liveRef.current;
    if (syncInFlightRef.current) return;
    if (currentServer == null || !hasSessionResync(currentServer) || currentSessionId == null) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    syncInFlightRef.current = true;
    void (async () => {
      try {
        const tip = await probeWithRetry(currentServer.peekSessionTip, currentSessionId);
        if (tip == null) return;
        if (tip.pendingApprovals.length > 0) {
          const oldestMs = Math.min(...tip.pendingApprovals.map(approval => Date.parse(approval.createdAt)));
          if (Number.isFinite(oldestMs) && Date.now() - oldestMs > APPROVAL_AUTO_DENY_MINUTES * 60_000) {
            const result = await currentServer
              .dismissPendingApprovals({
                sessionId: currentSessionId,
                reason: approvalAutoDenyReason(),
              })
              .catch((error: unknown) => {
                // The chat moved on while we looked; nothing to deny. A background cleanup
                // must not surface an error the user did not cause.
                if (isStaleApprovalError(error)) return { dismissed: 0, alreadyResolved: true };
                throw error;
              });
            if (!result.alreadyResolved) {
              const plural = result.dismissed === 1 ? '' : 's';
              currentToaster?.showSuccess({
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
          currentReload();
        } else if (lastTipRef.current !== undefined && tip.turnId !== lastTipRef.current) {
          currentReload();
        }
        lastTipRef.current = tip.turnId;
      } catch (error) {
        currentToaster?.showError(error instanceof Error ? error : new Error('Could not reach the chat server.'));
      } finally {
        syncInFlightRef.current = false;
      }
    })();
  }, []);

  return { syncNow };
}

/**
 * Wires chat lifecycle events to `useSessionEventSync`. Mount once inside the
 * agent runtime provider. Returns null; all work happens in effects.
 */
export function ForegroundEventSync(): null {
  const { syncNow } = useSessionEventSync();
  const reload = useTrueFoundryReload();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    let debounceId: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;

    const scheduleSync = () => {
      if (debounceId !== undefined) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        debounceId = undefined;
        syncNowRef.current('foreground');
      }, FOREGROUND_SYNC_DEBOUNCE_MS);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      const hiddenForMs = hiddenAt == null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (hiddenForMs >= FOREGROUND_SYNC_MIN_HIDDEN_MS) scheduleSync();
    };
    // Some mobile browsers deliver focus without visibilitychange; treat a
    // focus after a recorded hide the same way.
    const onFocus = () => {
      if (hiddenAt != null && !document.hidden) {
        hiddenAt = null;
        scheduleSync();
      }
    };
    const onOnline = () => syncNowRef.current('foreground');
    const onBlockedSend = () => syncNowRef.current('blocked-send');

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    const unsubscribeBlockedSend = subscribeToBlockedSend(onBlockedSend);
    const unsubscribeStaleApproval = subscribeToStaleApproval(() => reloadRef.current());
    return () => {
      unsubscribeStaleApproval();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      unsubscribeBlockedSend();
      if (debounceId !== undefined) clearTimeout(debounceId);
    };
  }, []);

  return null;
}
