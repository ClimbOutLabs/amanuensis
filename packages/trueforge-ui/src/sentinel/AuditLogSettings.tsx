'use client';

import { useCallback, useEffect, useRef, useState, type FC } from 'react';

import { auiButtonClass } from '../atoms/lib/buttonClasses.js';
import { Icon } from '../icons/Icon.js';
import { buildSessionResumeHref } from '../routing/paths.js';
import { useOptionalResolvedRoutes } from '../routing/ResolvedRoutesContext.js';
import { useOptionalSentinelApi } from './SentinelApiContext.js';
import { outcomeTone } from './SentinelAuditFeed.js';
import {
  SENTINEL_AUDIT_OUTCOME_LABELS,
  SENTINEL_AUDIT_OUTCOMES,
  sentinelAuditLabel,
  type SentinelAuditOutcome,
  type SentinelUserAuditEntry,
} from './types.js';

const PAGE_SIZE = 50;

const formatWhen = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function whenLabel(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? createdAt : formatWhen.format(date);
}

function parseOutcomeFilter(value: string): SentinelAuditOutcome | undefined {
  return SENTINEL_AUDIT_OUTCOMES.find(outcome => outcome === value);
}

/** A date input value (yyyy-mm-dd) as the local start of that day; undefined when the value is not a date. */
function parseLocalDay(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) return undefined;
  const [, year, month, day] = parts;
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function localDayStartIso(value: string): string | undefined {
  return parseLocalDay(value)?.toISOString();
}

/** The local start of the day after a date input value, so the picked day itself is fully included. */
function localDayAfterStartIso(value: string): string | undefined {
  const date = parseLocalDay(value);
  if (date === undefined) return undefined;
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

const AuditRow: FC<{ entry: SentinelUserAuditEntry; chatHref: string | null }> = ({ entry, chatHref }) => (
  <li className="flex flex-col gap-1 border-b border-border/60 px-4 py-3 last:border-b-0">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <time dateTime={entry.created_at} className="text-xs text-text-secondary">
        {whenLabel(entry.created_at)}
      </time>
      <span className={`text-xs font-medium ${outcomeTone(entry.outcome)}`}>{sentinelAuditLabel(entry)}</span>
    </div>
    <p className="text-sm text-text-primary">{entry.description}</p>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-text-secondary">
      <span className="min-w-0 truncate font-mono">{entry.action_type}</span>
      {!entry.chat_exists ? (
        <span>Chat deleted</span>
      ) : chatHref !== null ? (
        <a href={chatHref} className="underline hover:text-text-primary">
          Open chat
        </a>
      ) : null}
    </div>
  </li>
);

/**
 * Settings > Audit: every Sentinel audit entry for the signed-in user across all chats, newest
 * first. Entries outlive their chat, so a deleted chat's rows stay listed without a link. Read-only.
 */
export const AuditLogSettings: FC = () => {
  const api = useOptionalSentinelApi();
  const routes = useOptionalResolvedRoutes();
  const [outcome, setOutcome] = useState<SentinelAuditOutcome | undefined>(undefined);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const datesPicked = fromDate !== '' || toDate !== '';
  const [entries, setEntries] = useState<SentinelUserAuditEntry[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drops replies from a filter the owner has since changed.
  const requestRef = useRef(0);

  const load = useCallback(
    async ({ pageToken, append }: { pageToken: string | undefined; append: boolean }) => {
      if (api === null) return;
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listUserAuditEntries({
          limit: PAGE_SIZE,
          pageToken,
          outcome,
          from: localDayStartIso(fromDate),
          to: localDayAfterStartIso(toDate),
        });
        if (request !== requestRef.current) return;
        setEntries(current => (append ? [...current, ...page.entries] : page.entries));
        setNextPageToken(page.nextPageToken);
      } catch (err) {
        if (request !== requestRef.current) return;
        setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [api, outcome, fromDate, toDate],
  );

  const clearDates = useCallback(() => {
    setFromDate('');
    setToDate('');
  }, []);

  useEffect(() => {
    setEntries([]);
    setNextPageToken(undefined);
    void load({ pageToken: undefined, append: false });
  }, [load]);

  if (api === null) {
    return <p className="text-sm text-text-secondary">The audit log is unavailable on this server.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Audit</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Everything the assistant asked to do on your behalf and what happened, across all your chats. Entries stay
          here even after you delete a chat.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          Show
          <select
            className="rounded-md border border-border bg-primary-bg px-2 py-1 text-sm text-text-primary"
            value={outcome ?? ''}
            onChange={event => setOutcome(parseOutcomeFilter(event.target.value))}
          >
            <option value="">Everything</option>
            {SENTINEL_AUDIT_OUTCOMES.map(value => (
              <option key={value} value={value}>
                {SENTINEL_AUDIT_OUTCOME_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          From
          <input
            type="date"
            className="rounded-md border border-border bg-primary-bg px-2 py-1 text-sm text-text-primary"
            value={fromDate}
            max={toDate === '' ? undefined : toDate}
            onChange={event => setFromDate(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-secondary">
          To
          <input
            type="date"
            className="rounded-md border border-border bg-primary-bg px-2 py-1 text-sm text-text-primary"
            value={toDate}
            min={fromDate === '' ? undefined : fromDate}
            onChange={event => setToDate(event.target.value)}
          />
        </label>
        {datesPicked ? (
          <button
            type="button"
            className={auiButtonClass({ variant: 'secondary', size: 'small' })}
            onClick={clearDates}
          >
            Clear dates
          </button>
        ) : null}
      </div>

      {error !== null && (
        <p className="flex items-center gap-1.5 text-sm text-failure-bg" role="alert">
          <Icon name="circle-exclamation" className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">Could not load the audit log: {error}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => void load({ pageToken: nextPageToken, append: entries.length > 0 })}
          >
            Retry
          </button>
        </p>
      )}

      {entries.length === 0 && !loading && error === null ? (
        datesPicked ? (
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 py-6 text-center text-sm text-text-secondary">
            Nothing in the audit log for those dates.
            <button type="button" className="underline hover:text-text-primary" onClick={clearDates}>
              Clear dates
            </button>
          </p>
        ) : (
          <p className="py-6 text-center text-sm text-text-secondary">Nothing recorded yet.</p>
        )
      ) : (
        <ul className="min-h-0 overflow-y-auto rounded-md border border-border">
          {entries.map(entry => (
            <AuditRow
              key={entry.id}
              entry={entry}
              chatHref={routes === null ? null : buildSessionResumeHref({ sessionId: entry.session_id, routes })}
            />
          ))}
        </ul>
      )}

      {nextPageToken !== undefined && (
        <button
          type="button"
          className={auiButtonClass({ variant: 'secondary', size: 'small', className: 'self-center' })}
          disabled={loading}
          onClick={() => void load({ pageToken: nextPageToken, append: true })}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
};
