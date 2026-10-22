'use client';

import { useCallback, useEffect, useMemo, useState, type FC } from 'react';

import { Icon } from '../icons/Icon.js';
import { ACTIVITY_STATE_DOT_CLASSES, ACTIVITY_STATE_LABELS, receiptRowsOf, type ReceiptRow } from './activityVerbs.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';
import type { SentinelAuditEntry, SentinelAuditOutcome } from './types.js';

/** Live refresh cadence for the receipt. */
const AUDIT_POLL_MS = 5000;

/** Rows shown before "Show all" appears. */
const RECEIPT_ROWS_SHOWN = 5;

export function outcomeTone(outcome: SentinelAuditOutcome): string {
  switch (outcome) {
    case 'approved':
    case 'ran':
      return 'text-text-secondary';
    case 'denied':
    case 'auto_denied':
      return 'text-failure-bg';
    case 'logged':
      return 'text-text-secondary';
  }
}

const ReceiptRowItem: FC<{ row: ReceiptRow }> = ({ row }) => (
  <li className="aui-row aui-row--2">
    <span className="text min-w-0 break-words">
      {row.verb}
      {row.count > 1 && ` · ${row.count}`}
    </span>
    <span className="state flex items-center gap-1.5 text-text-secondary">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${ACTIVITY_STATE_DOT_CLASSES[row.state]}`} />
      {ACTIVITY_STATE_LABELS[row.state]}
    </span>
  </li>
);

export type SentinelAuditFeedProps = {
  sessionId: string;
};

/**
 * The receipt for the active session: every permission-relevant action grouped into one row per
 * verb and state, with a count. Polls the host's audit-log API. The raw tool name and the
 * per-entry detail are not shown here.
 */
export const SentinelAuditFeed: FC<SentinelAuditFeedProps> = ({ sessionId }) => {
  const sentinel = useOptionalSentinelApiState();
  const api = sentinel?.api ?? null;
  const [entries, setEntries] = useState<SentinelAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

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
    setShowAll(false);
    void load();
    if (api === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, AUDIT_POLL_MS);
    return () => clearInterval(timer);
  }, [api, load]);

  const rows = useMemo(() => receiptRowsOf(entries), [entries]);

  if (api === null) return null;

  const visibleRows = showAll ? rows : rows.slice(0, RECEIPT_ROWS_SHOWN);

  return (
    <div className="flex min-h-0 flex-col">
      {error !== null && (
        <p className="flex items-center gap-1.5 py-2 text-xs text-failure-bg" role="alert">
          <Icon name="circle-exclamation" className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">Could not load recent actions: {error}</span>
          <button type="button" className="shrink-0 underline" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}

      {entries.length === 0 && error === null ? (
        <p className="py-4 text-center text-xs text-text-secondary">Nothing has happened in this chat yet.</p>
      ) : (
        <>
          <ul className="aui-receipt">
            {visibleRows.map(row => (
              <ReceiptRowItem key={row.key} row={row} />
            ))}
          </ul>
          {rows.length > RECEIPT_ROWS_SHOWN && (
            <button
              type="button"
              className="mt-2 w-full text-center font-mono text-[0.68rem] uppercase tracking-widest text-gold-ink underline underline-offset-2"
              aria-expanded={showAll}
              onClick={() => setShowAll(previous => !previous)}
            >
              {showAll ? 'Show less' : `Show all (${entries.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
};
