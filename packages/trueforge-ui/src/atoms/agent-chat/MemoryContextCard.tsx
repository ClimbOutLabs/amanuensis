'use client';

import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { useState } from 'react';

import { SyntaxHighlighter } from '../SyntaxHighlighter.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { AgentStepRow, type AgentStepStatus } from './AgentStepRow.js';

export type MemoryContextCardProps = {
  recall?: TrueForgeApi.MemoryRecallPersistedEvent;
  profile?: TrueForgeApi.ProfileLearnedPersistedEvent;
  /**
   * Set when the durable context fetch is currently failing and this turn has no loaded recall or
   * profile data to show. Renders an explicit "unavailable" row instead of nothing, so the viewer
   * can tell "no context this turn" apart from "couldn't check" (SPEC.md I5). Ignored once `recall`
   * or `profile` is set — loaded data always wins.
   */
  unavailable?: boolean;
  /** Retries the failed fetch. Only rendered when both `unavailable` and this are set. */
  onRetry?: () => void;
  className?: string;
};

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${String(ms)}ms`;
}

/** `pluralForm` and `singular` are both plain strings — grouped so a call site can't swap them. */
function plural(
  count: number,
  { singular, pluralForm = `${singular}s` }: { singular: string; pluralForm?: string },
): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

function RecallRow({ event }: { event: TrueForgeApi.MemoryRecallPersistedEvent }) {
  const [expanded, setExpanded] = useState(false);
  const { stats, sweep, screen, injectedBlock } = event;

  let status: AgentStepStatus = 'muted';
  let statusText = 'No memory recalled';
  if (stats.outcome === 'ok') {
    status = 'success';
    statusText = `${plural(stats.items, { singular: 'item' })}, ${plural(stats.entities, { singular: 'entity', pluralForm: 'entities' })}`;
  } else if (stats.outcome === 'timeout' || stats.outcome === 'error') {
    status = 'warning';
    statusText = stats.outcome === 'timeout' ? 'Recall timed out' : 'Recall failed';
  }

  const hasSweepActivity = sweep.verified + sweep.retried + sweep.abandoned + sweep.pending > 0;

  return (
    <AgentStepRow
      icon="brain"
      title="Recalled memory"
      expandable
      expanded={expanded}
      onToggle={() => setExpanded(prev => !prev)}
      status={status}
      statusText={statusText}
      dataTestPrefix="memory-recall"
    >
      <div className="flex flex-col gap-2 pb-1 font-sans text-xs text-text-secondary">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span>{plural(stats.items, { singular: 'item' })}</span>
          <span>{plural(stats.entities, { singular: 'entity', pluralForm: 'entities' })}</span>
          <span>~{stats.estimatedTokens} tokens</span>
          <span>{formatMs(stats.recallMs)}</span>
          {stats.droppedOverBudget > 0 && (
            <span>{plural(stats.droppedOverBudget, { singular: 'item' })} dropped over budget</span>
          )}
        </div>
        {stats.reason && <p className="text-failure-bg">{stats.reason}</p>}
        {hasSweepActivity && (
          <p>
            Retain sweep — verified {sweep.verified}, retried {sweep.retried}, abandoned {sweep.abandoned}, pending{' '}
            {sweep.pending}
          </p>
        )}
        {screen && (
          <div className="flex flex-col gap-1">
            <p>Recall screen withheld {plural(screen.withheld, { singular: 'item' })}</p>
            {screen.records.length > 0 && (
              <ul className="flex flex-col gap-0.5 pl-3">
                {screen.records.map(record => (
                  <li key={record.id} className="list-disc font-mono text-[0.6875rem]">
                    {record.id} · score {record.score.toFixed(2)} · {record.reason} · origin {record.origin} ·{' '}
                    {record.withheld ? 'withheld' : 'kept'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <p className="mb-1 font-medium text-text-primary">Injected block</p>
          {injectedBlock !== null ? (
            <SyntaxHighlighter code={injectedBlock} language="markdown" />
          ) : (
            <p className="italic">Nothing was injected this turn.</p>
          )}
        </div>
      </div>
    </AgentStepRow>
  );
}

function ProfileRow({ event }: { event: TrueForgeApi.ProfileLearnedPersistedEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <AgentStepRow
      icon="book-open"
      title="Learned profile updated"
      expandable
      expanded={expanded}
      onToggle={() => setExpanded(prev => !prev)}
      status="success"
      statusText={`revision ${event.revision}`}
      dataTestPrefix="profile-learned"
    >
      <div className="flex flex-col gap-2 pb-1 font-sans text-xs text-text-secondary">
        {event.previous !== null && (
          <div>
            <p className="mb-1 font-medium text-text-primary">Previous document</p>
            <SyntaxHighlighter code={event.previous} language="markdown" />
          </div>
        )}
        <div>
          <p className="mb-1 font-medium text-text-primary">Current document</p>
          <SyntaxHighlighter code={event.current} language="markdown" />
        </div>
      </div>
    </AgentStepRow>
  );
}

/**
 * Durable, read-only rendering of the host-injected memory recall and/or learned-profile write
 * for one turn — exactly what `aman.memory.recall` / `aman.profile.learned` carry, nothing more
 * (SPEC.md I5). Renders nothing when neither event happened this turn and the fetch that would
 * have found them is not currently failing; renders an explicit "unavailable" row instead of
 * nothing when it is (`unavailable`), so a broken audit read is never mistaken for "no context
 * happened" this turn. A viewer, not an editor: there is no control here that changes anything the
 * host holds — `onRetry` only re-issues the read.
 */
export function MemoryContextCard({ recall, profile, unavailable, onRetry, className }: MemoryContextCardProps) {
  if (recall == null && profile == null) {
    if (!unavailable) return null;
    return (
      <div
        className={cn('mb-3 flex flex-col gap-3 rounded-lg border border-border bg-card-bg p-2', className)}
        data-testid="memory-context-card"
      >
        <AgentStepRow
          icon="triangle-exclamation"
          title="Memory context unavailable"
          status="warning"
          statusText="Could not load recall/profile audit"
          dataTestPrefix="memory-context-unavailable"
          persistentChildren={
            onRetry ? (
              <Button
                variant="ghost"
                size="small"
                type="button"
                onClick={onRetry}
                data-testid="memory-context-unavailable-retry"
              >
                Retry
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <div
      className={cn('mb-3 flex flex-col gap-3 rounded-lg border border-border bg-card-bg p-2', className)}
      data-testid="memory-context-card"
    >
      {recall && <RecallRow event={recall} />}
      {profile && <ProfileRow event={profile} />}
    </div>
  );
}
