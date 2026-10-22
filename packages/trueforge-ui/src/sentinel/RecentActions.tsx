'use client';

import { useCallback, useEffect, useState, type FC } from 'react';

import { RailDisclosure } from '../components/RailDisclosure.js';
import { Icon } from '../icons/Icon.js';
import { groupActivityRows, relativeTimeLabel, type ActivityRow } from './activityVerbs.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';
import type { SentinelApi, SentinelAuditEntry } from './types.js';

/** Live refresh cadence for the list. */
const AUDIT_POLL_MS = 5000;

/** Rows shown before "Show all" appears. */
const ROWS_SHOWN = 4;

/** Loads the chat's audit rows and keeps them fresh while the tab is visible. */
function useSessionAuditEntries({ api, sessionId }: { api: SentinelApi | null; sessionId: string }) {
  const [entries, setEntries] = useState<SentinelAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (api === null) return;
    try {
      const next = await api.listAuditEntries({ sessionId, limit: 50 });
      setEntries(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    }
  }, [api, sessionId]);

  useEffect(() => {
    setEntries([]);
    setError(null);
    void load();
    if (api === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, AUDIT_POLL_MS);
    return () => clearInterval(timer);
  }, [api, load]);

  return { entries, error, reload: load };
}

function ActivityRowItem({ row, now }: { row: ActivityRow; now: Date }) {
  return (
    <li className="aman-runtime-rail__row" tabIndex={0} data-failed={row.failed ? 'true' : undefined}>
      <span className="aman-runtime-rail__mark" aria-hidden="true">
        {row.mark}
      </span>
      <span className="aman-runtime-rail__row-text">
        <span className="aman-runtime-rail__row-title">{row.title}</span>
        <span className="aman-runtime-rail__row-subtitle">{row.subtitle}</span>
      </span>
      <time className="aman-runtime-rail__row-time" dateTime={row.createdAt}>
        {relativeTimeLabel({ iso: row.createdAt, now })}
      </time>
    </li>
  );
}

type RecentActionsProps = {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
};

/**
 * The rail's Recent actions: folded to a count and the latest action, expanded to the newest
 * rows grouped by reply. Renders nothing when the host has no sentinel API to read from.
 */
export const RecentActions: FC<RecentActionsProps> = ({ sessionId, open, onToggle }) => {
  const sentinel = useOptionalSentinelApiState();
  const api = sentinel?.api ?? null;
  const { entries, error, reload } = useSessionAuditEntries({ api, sessionId });
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setShowAll(false);
  }, [sessionId]);

  if (api === null) return null;

  const now = new Date();
  const groups = groupActivityRows({ entries, now });
  const ordered = groups.flatMap(group => group.rows);
  const latest = ordered[0];
  const visibleIds = new Set(ordered.slice(0, showAll ? ordered.length : ROWS_SHOWN).map(row => row.id));
  const anyFailed = ordered.some(row => row.failed);

  return (
    <RailDisclosure
      section="recent-actions"
      title="Recent actions"
      open={open}
      onToggle={onToggle}
      count={entries.length === 0 ? undefined : `· ${entries.length}`}
      attention={anyFailed}
      detail={
        latest === undefined
          ? undefined
          : `Last: ${latest.title} · ${relativeTimeLabel({ iso: latest.createdAt, now })}`
      }
    >
      {error !== null && (
        <p className="aman-runtime-rail__notice" role="alert">
          <Icon name="circle-exclamation" className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">Could not load recent actions: {error}</span>
          <button type="button" className="aman-runtime-rail__text-button" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      )}

      {entries.length === 0 && error === null ? (
        <p className="aman-runtime-rail__empty">Nothing has happened in this chat yet.</p>
      ) : (
        <>
          {groups.map(group => {
            const rows = group.rows.filter(row => visibleIds.has(row.id));
            if (rows.length === 0) return null;
            return (
              <div key={group.key} className="aman-runtime-rail__group">
                <p className="aman-runtime-rail__group-label">{group.label}</p>
                <ul className="aman-runtime-rail__rows">
                  {rows.map(row => (
                    <ActivityRowItem key={row.id} row={row} now={now} />
                  ))}
                </ul>
              </div>
            );
          })}
          {entries.length > ROWS_SHOWN && (
            <button
              type="button"
              className="aman-runtime-rail__show-all"
              aria-expanded={showAll}
              onClick={() => setShowAll(previous => !previous)}
            >
              {showAll ? 'Show fewer' : `Show all ${entries.length}`}
            </button>
          )}
        </>
      )}
    </RailDisclosure>
  );
};
