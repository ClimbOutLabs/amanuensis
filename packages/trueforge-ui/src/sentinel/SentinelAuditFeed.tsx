'use client';

import { useCallback, useEffect, useMemo, useState, type FC } from 'react';

import { MessageTimestamp } from '../atoms/MessageTimestamp.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';
import { Tier2EscalationToggle } from './Tier2EscalationToggle.js';
import {
  TIER2_ACTION_KINDS,
  TIER2_ACTION_LABELS,
  type SentinelAuditEntry,
  type SentinelAuditOutcome,
  type SentinelUserSettings,
  type Tier2ActionKind,
} from './types.js';

/** Live refresh cadence for the permissions audit feed. */
const AUDIT_POLL_MS = 5000;

const OUTCOME_LABELS: Record<SentinelAuditOutcome, string> = {
  logged: 'Logged',
  ran: 'Ran',
  stopped_by_user: 'Stopped by user',
  undone: 'Undone',
  approved: 'Approved',
  denied: 'Denied',
  auto_denied: 'Auto-denied',
};

function outcomeTone(outcome: SentinelAuditOutcome): string {
  switch (outcome) {
    case 'approved':
    case 'ran':
    case 'undone':
    case 'stopped_by_user':
      return 'text-text-secondary';
    case 'denied':
    case 'auto_denied':
      return 'text-failure-bg';
    case 'logged':
      return 'text-text-secondary';
  }
}

const AuditEntryRow: FC<{ entry: SentinelAuditEntry }> = ({ entry }) => (
  <li className="border-b border-border/60 px-3 py-2 last:border-b-0">
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate font-mono text-[0.6875rem] text-text-secondary">
        {entry.action_type}
      </span>
      <MessageTimestamp
        createdAt={entry.created_at}
        className="text-[0.6875rem] font-normal"
      />
    </div>
    <p className="mt-0.5 text-xs text-text-primary">{entry.description}</p>
    <p className={`mt-0.5 text-[0.6875rem] font-medium ${outcomeTone(entry.outcome)}`}>
      {OUTCOME_LABELS[entry.outcome]}
      {entry.reason !== undefined && entry.reason !== '' && (
        <span className="font-normal text-text-secondary"> · {entry.reason}</span>
      )}
    </p>
  </li>
);

export type SentinelAuditFeedProps = {
  sessionId: string;
};

/**
 * Live permissions audit feed for the right rail. Polls the host's audit-log API for
 * the active session: Tier 1 sensitive reads (`logged`), Tier 2 executions (`ran`,
 * `stopped_by_user`, `undone`) and Tier 3 decisions (`approved`, `denied`,
 * `auto_denied` with the reason). Each Tier 2 action kind gets an "always ask me"
 * toggle beside it, wired to the user settings API.
 */
export const SentinelAuditFeed: FC<SentinelAuditFeedProps> = ({ sessionId }) => {
  const sentinel = useOptionalSentinelApiState();
  const api = sentinel?.api ?? null;
  const settings = sentinel?.settings ?? null;
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

  const tier2ActionKinds: Tier2ActionKind[] = useMemo(() => [...TIER2_ACTION_KINDS], []);

  const handleToggle = useCallback(
    async (input: { actionType: Tier2ActionKind; escalated: boolean }) => {
      if (sentinel === null) return;
      const current = sentinel.settings?.tier2_always_ask ?? [];
      const next: Tier2ActionKind[] = input.escalated
        ? (current.includes(input.actionType) ? current : [...current, input.actionType])
        : current.filter(kind => kind !== input.actionType);
      const patch: Partial<SentinelUserSettings> = { tier2_always_ask: next };
      await sentinel.updateSettings(patch);
    },
    [sentinel],
  );

  if (api === null) return null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <p className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-text-secondary">
          Sensitive actions
        </p>
        <ul className="space-y-1.5">
          {tier2ActionKinds.map(kind => (
            <li key={kind} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[0.6875rem] text-text-secondary">
                {TIER2_ACTION_LABELS[kind]}
              </span>
              <Tier2EscalationToggle
                actionType={kind}
                escalated={settings?.tier2_always_ask.includes(kind) ?? false}
                onChange={handleToggle}
              />
            </li>
          ))}
        </ul>
      </div>

      {error !== null && (
        <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-failure-bg" role="alert">
          <Icon name="circle-exclamation" className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">Could not load the audit feed: {error}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => void load()}
          >
            Retry
          </button>
        </p>
      )}

      {entries.length === 0 && error === null ? (
        <p className="px-3 py-4 text-center text-xs text-text-secondary">
          No permission activity in this session yet.
        </p>
      ) : (
        <ul className="min-h-0 overflow-y-auto">
          {entries.map(entry => (
            <AuditEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
};
