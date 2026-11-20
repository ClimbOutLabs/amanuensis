'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuiState } from '../assistant-ui.js';
import { Button } from '../atoms/primitives/Button.js';
import {
  useOptionalImplementationPlanGrants,
  type ImplementationPlanGrant,
  type ImplementationPlanGrantApi,
} from '../components/ImplementationPlanGrantContext.js';
import { getErrorMessage } from '../utils/getErrorMessage.js';
import { isNetworkFailureError } from '../utils/liveConnection.js';

const POLL_INTERVAL_MS = 2_000;
// After a failed read the list tries again on its own, even between replies, so a restart or a
// dropped connection heals without the person doing anything.
const RETRY_AFTER_FAILURE_MS = 5_000;

const STILL_APPROVED_OFFLINE =
  'The app could not be reached, so this plan is still approved. Try again when the connection is back.';

function revokeErrorMessage(error: unknown): string {
  if (isNetworkFailureError(error)) return STILL_APPROVED_OFFLINE;
  return getErrorMessage(error, 'Could not stop this plan. Try again in a moment.');
}

/** Grants are immutable once minted, so the same ids and plan hashes in order mean nothing changed. */
function sameGrants({
  shown,
  next,
}: {
  shown: readonly ImplementationPlanGrant[];
  next: readonly ImplementationPlanGrant[];
}): boolean {
  return (
    shown.length === next.length &&
    shown.every(
      (grant, index) => grant.grant_id === next[index]?.grant_id && grant.plan_hash === next[index]?.plan_hash,
    )
  );
}

export type ImplementationPlanGrantControlsProps = {
  sessionId?: string | null;
  isRunning?: boolean;
};

function ImplementationPlanGrantControlsWithApi({
  api,
  sessionId,
  isRunning = false,
}: ImplementationPlanGrantControlsProps & { api: ImplementationPlanGrantApi }) {
  const [grants, setGrants] = useState<ImplementationPlanGrant[]>([]);
  // A failed read never shows on its own: the app's connection notice already covers a dropped
  // connection, and an empty list has nothing to protect. Only a list already on screen says it
  // may be out of date.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  const requestVersionRef = useRef(0);
  sessionIdRef.current = sessionId;
  // What is on screen, so a poll that changes nothing dispatches no state update at all.
  const shownRef = useRef({ grants, refreshFailed });
  useEffect(() => {
    shownRef.current = { grants, refreshFailed };
  });

  const { listImplementationPlanGrants, revokeImplementationPlanGrant } = api;

  useEffect(() => {
    requestVersionRef.current += 1;
    setGrants([]);
    setRefreshFailed(false);
    setRevokeError(null);
    setRevokingGrantId(null);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId == null) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let lastReadFailed = false;
    let retryId: ReturnType<typeof setTimeout> | undefined;
    const scheduleRetry = () => {
      // While a reply runs the poll already retries; a hidden tab retries when it is shown again.
      if (isRunning || retryId !== undefined) return;
      retryId = setTimeout(() => {
        retryId = undefined;
        if (document.visibilityState === 'visible') refresh();
      }, RETRY_AFTER_FAILURE_MS);
    };
    const refresh = () => {
      // A tick that lands while the previous read is still out skips rather than stacking requests.
      if (inFlight) {
        return;
      }
      inFlight = true;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      void listImplementationPlanGrants(sessionId)
        .then(next => {
          if (!cancelled && requestVersionRef.current === requestVersion) {
            lastReadFailed = false;
            if (!sameGrants({ shown: shownRef.current.grants, next })) setGrants(next);
            if (shownRef.current.refreshFailed) setRefreshFailed(false);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          lastReadFailed = true;
          scheduleRetry();
          if (requestVersionRef.current === requestVersion && !isNetworkFailureError(error)) {
            if (!shownRef.current.refreshFailed) setRefreshFailed(true);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    // Skip poll ticks while the tab is hidden (matching SentinelAuditFeed) so a hidden tab
    // fires no requests; refresh once immediately when the tab becomes visible again.
    const intervalId = isRunning
      ? setInterval(() => {
          if (document.visibilityState === 'visible') refresh();
        }, POLL_INTERVAL_MS)
      : undefined;
    const handleVisibilityChange = () => {
      if ((isRunning || lastReadFailed) && document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (intervalId !== undefined) clearInterval(intervalId);
      if (retryId !== undefined) clearTimeout(retryId);
    };
  }, [isRunning, listImplementationPlanGrants, sessionId]);

  const revoke = useCallback(
    (grant: ImplementationPlanGrant) => {
      if (sessionId == null) {
        return;
      }
      const requestedSessionId = sessionId;
      requestVersionRef.current += 1;
      setRevokeError(null);
      setRevokingGrantId(grant.grant_id);
      void revokeImplementationPlanGrant({ sessionId: requestedSessionId, grantId: grant.grant_id })
        .then(() => {
          if (sessionIdRef.current === requestedSessionId) {
            setGrants(current => current.filter(item => item.grant_id !== grant.grant_id));
          }
        })
        .catch((error: unknown) => {
          if (sessionIdRef.current === requestedSessionId) {
            setRevokeError(revokeErrorMessage(error));
          }
        })
        .finally(() => {
          if (sessionIdRef.current === requestedSessionId) {
            setRevokingGrantId(null);
          }
        });
    },
    [revokeImplementationPlanGrant, sessionId],
  );

  // Stopping a plan removes it from the list, so an empty list has nothing to show.
  if (grants.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Approved plans for code changes"
      className="rounded-lg border border-border bg-card-bg px-3 py-2.5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-sans text-xs font-semibold text-text-primary">Approved plans for code changes</h2>
          <p className="mt-0.5 font-sans text-[0.6875rem] leading-relaxed text-text-secondary">
            The assistant can only change the files and run the checks listed here. Stop a plan to block any more
            changes under it.
          </p>
        </div>
      </div>

      {revokeError ? (
        <p className="mt-2 font-sans text-xs text-failure-bg" role="alert">
          {revokeError}
        </p>
      ) : null}
      {refreshFailed ? (
        <p className="mt-2 font-sans text-[0.6875rem] text-text-secondary" role="status">
          This list could not be refreshed, so it may be out of date. It tries again on its own.
        </p>
      ) : null}

      {grants.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {grants.map(grant => (
            <li key={grant.grant_id} className="rounded-md border border-border bg-primary-bg px-2.5 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-xs font-medium leading-snug text-text-primary">{grant.plan.approach}</p>
                  <p className="mt-0.5 font-mono text-[0.6875rem] text-text-secondary">
                    {grant.plan.branch} · {grant.plan.head_sha.slice(0, 8)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  aria-label={`Stop plan: ${grant.plan.approach}`}
                  disabled={revokingGrantId !== null}
                  onClick={() => revoke(grant)}
                >
                  {revokingGrantId === grant.grant_id ? 'Stopping…' : 'Stop plan'}
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1" aria-label="Files it may change">
                {grant.plan.file_globs.map(path => (
                  <span
                    key={path}
                    className="rounded bg-secondary-bg px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-secondary"
                  >
                    {path}
                  </span>
                ))}
              </div>
              {grant.plan.verify_command_ids.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1" aria-label="Checks it may run">
                  {grant.plan.verify_command_ids.map(commandId => (
                    <span
                      key={commandId}
                      className="rounded bg-secondary-bg px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-secondary"
                    >
                      {commandId}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ImplementationPlanGrantControls({ sessionId, isRunning }: ImplementationPlanGrantControlsProps) {
  const api = useOptionalImplementationPlanGrants();
  if (api == null) {
    return null;
  }
  return (
    <ImplementationPlanGrantControlsWithApi
      api={api}
      sessionId={sessionId}
      {...(isRunning === undefined ? {} : { isRunning })}
    />
  );
}

export function ThreadImplementationPlanGrantControls() {
  const api = useOptionalImplementationPlanGrants();
  if (api == null) {
    return null;
  }
  return <ConnectedThreadImplementationPlanGrantControls api={api} />;
}

function ConnectedThreadImplementationPlanGrantControls({ api }: { api: ImplementationPlanGrantApi }) {
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const isRunning = useThreadIsRunning();
  return <ImplementationPlanGrantControlsWithApi api={api} sessionId={sessionId} isRunning={isRunning} />;
}
