'use client';

import { useCallback, useEffect, useMemo, useState, type FC } from 'react';

import { MessageTimestamp } from '../atoms/MessageTimestamp.js';
import { Icon } from '../icons/Icon.js';
import { plainActionTypeLabel } from '../utils/toolCallParsing.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';
import { Tier2RelaxationToggle } from './Tier2RelaxationToggle.js';
import {
  plainAuditReason,
  SENTINEL_AUDIT_OUTCOME_LABELS,
  TIER2_ACTION_KINDS,
  TIER2_ACTION_LABELS,
  type SentinelAuditEntry,
  type SentinelAuditOutcome,
  type Tier2ActionKind,
} from './types.js';

/** Live refresh cadence for the permissions audit feed. */
const AUDIT_POLL_MS = 5000;

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

const AuditEntryRow: FC<{ entry: SentinelAuditEntry }> = ({ entry }) => (
  <li className="border-b border-border/60 px-3 py-2 last:border-b-0">
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate text-[0.6875rem] text-text-secondary">
        {plainActionTypeLabel(entry.action_type)}
      </span>
      <MessageTimestamp createdAt={entry.created_at} className="text-[0.6875rem] font-normal" />
    </div>
    <p className="mt-0.5 text-xs text-text-primary">{entry.description}</p>
    <p className={`mt-0.5 text-[0.6875rem] font-medium ${outcomeTone(entry.outcome)}`}>
      {SENTINEL_AUDIT_OUTCOME_LABELS[entry.outcome]}
      {entry.reason !== undefined && entry.reason !== '' && (
        <span className="font-normal text-text-secondary"> · {plainAuditReason(entry.reason)}</span>
      )}
    </p>
  </li>
);

export type SentinelAuditFeedProps = {
  sessionId: string;
};

/**
 * Live permissions audit feed for the right rail. Polls the host's audit-log API for
 * the active session: Tier 1 sensitive reads (`logged`), Tier 2 and Tier 3 decisions
 * (`approved`, `denied`), relaxed Tier 2 executions (`ran`) and auto-denials
 * (`auto_denied` with the reason). Each Tier 2 action kind gets an "Always allow"
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
    async (input: { actionType: Tier2ActionKind; relaxed: boolean }) => {
      if (sentinel === null) return;
      // Derived from the latest saved settings, not this render's snapshot, so a toggle of
      // another kind that is still saving is not overwritten.
      await sentinel.updateSettings(({ tier2_auto_allow: current }) => ({
        tier2_auto_allow: input.relaxed
          ? current.includes(input.actionType)
            ? current
            : [...current, input.actionType]
          : current.filter(kind => kind !== input.actionType),
      }));
    },
    [sentinel],
  );

  if (api === null) return null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <p className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-text-secondary">Always allow</p>
        <ul className="space-y-1.5">
          {tier2ActionKinds.map(kind => (
            <li key={kind} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[0.6875rem] text-text-secondary">{TIER2_ACTION_LABELS[kind]}</span>
              <Tier2RelaxationToggle
                actionType={kind}
                relaxed={settings?.tier2_auto_allow.includes(kind) ?? false}
                disabled={settings === null}
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
          <button type="button" className="shrink-0 underline" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}

      <p className="px-3 pt-2 text-[0.6875rem] font-medium uppercase tracking-wide text-text-secondary">
        Recent actions
      </p>

      {entries.length === 0 && error === null ? (
        <p className="px-3 py-4 text-center text-xs text-text-secondary">No permission activity in this session yet.</p>
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
