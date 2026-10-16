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

const POLL_INTERVAL_MS = 2_000;

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  const requestVersionRef = useRef(0);
  sessionIdRef.current = sessionId;
  // What is on screen, so a poll that changes nothing dispatches no state update at all.
  const shownRef = useRef({ grants, loadError });
  useEffect(() => {
    shownRef.current = { grants, loadError };
  });

  const { listImplementationPlanGrants, revokeImplementationPlanGrant } = api;

  useEffect(() => {
    requestVersionRef.current += 1;
    setGrants([]);
    setLoadError(null);
    setRevokingGrantId(null);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId == null) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
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
            if (!sameGrants({ shown: shownRef.current.grants, next })) setGrants(next);
            if (shownRef.current.loadError !== null) setLoadError(null);
          }
        })
        .catch(error => {
          if (!cancelled && requestVersionRef.current === requestVersion) {
            setLoadError(getErrorMessage(error, 'Could not load implementation-plan grants.'));
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
      if (isRunning && document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, [isRunning, listImplementationPlanGrants, sessionId]);

  const revoke = useCallback(
    (grant: ImplementationPlanGrant) => {
      if (sessionId == null) {
        return;
      }
      const requestedSessionId = sessionId;
      requestVersionRef.current += 1;
      setLoadError(null);
      setRevokingGrantId(grant.grant_id);
      void revokeImplementationPlanGrant({ sessionId: requestedSessionId, grantId: grant.grant_id })
        .then(() => {
          if (sessionIdRef.current === requestedSessionId) {
            setGrants(current => current.filter(item => item.grant_id !== grant.grant_id));
          }
        })
        .catch(error => {
          if (sessionIdRef.current === requestedSessionId) {
            setLoadError(getErrorMessage(error, 'Could not revoke the implementation-plan grant.'));
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

  if (grants.length === 0 && loadError == null) {
    return null;
  }

  return (
    <section
      aria-label="Active implementation plans"
      className="rounded-lg border border-border bg-card-bg px-3 py-2.5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-sans text-xs font-semibold text-text-primary">Approved implementation plans</h2>
          <p className="mt-0.5 font-sans text-[0.6875rem] leading-relaxed text-text-secondary">
            Only the listed edits and checks can be admitted. Revoke a plan to stop future dispatches.
          </p>
        </div>
      </div>

      {loadError ? (
        <p className="mt-2 font-sans text-xs text-failure-bg" role="alert">
          {loadError}
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
                    {grant.plan.branch} @ {grant.plan.head_sha.slice(0, 8)} · revision {grant.plan.repository_revision}
                  </p>
                </div>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  aria-label={`Revoke ${grant.plan.approach}`}
                  disabled={revokingGrantId !== null}
                  onClick={() => revoke(grant)}
                >
                  {revokingGrantId === grant.grant_id ? 'Revoking…' : 'Revoke'}
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap gap-1" aria-label="Allowed paths">
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
                <div className="mt-1 flex flex-wrap gap-1" aria-label="Allowed checks">
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
