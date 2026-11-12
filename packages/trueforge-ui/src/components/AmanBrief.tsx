'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { GoldTick } from '../atoms/Reward.js';
import { useSendPrompt } from '../hooks/useSendPrompt.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import { greetingLine } from './AmanTour.js';
import {
  briefFooterLine,
  briefOmittedLine,
  briefWhenLabel,
  buildBriefView,
  summarizeBriefAudit,
  type BriefAuditSummary,
  type BriefViewItem,
  type BriefViewSection,
  type MorningBrief,
} from './briefSections.js';
import { useOptionalPersonalization } from './PersonalizationContext.js';
import { personDisplayName } from './personDisplayName.js';

/** The fade a done row takes before its Undo shows. */
const DONE_FADE_MS = 225;
/** How long Undo stays in a row's place. */
const UNDO_WINDOW_MS = 5000;

export type AmanBriefProps = {
  brief: MorningBrief;
  /** Items in the answer that did not fit the brief's shape and were left out. */
  omittedCount: number;
  /** Identifies this brief for the greeting heading's id. */
  briefId: string;
  /** The chat the brief came from: the audit entries for the trust line, and where done marks are logged. */
  sessionId: string | undefined;
};

/** A row's state after the person marks it done: the fade, then Undo for a few seconds, then gone. */
type DonePhase = 'fading' | 'undo';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A plain card with the brief's greeting, digest, sections and trust line. */
export function AmanBrief({ brief, omittedCount, briefId, sessionId }: AmanBriefProps) {
  const api = useOptionalSentinelApiState()?.api ?? null;
  const profile = useOptionalPersonalization()?.profile;
  const name = personDisplayName({ profile, signInName: undefined });
  const [expanded, setExpanded] = useState(false);
  // Keys done on the server (last 7 days) plus rows whose Undo window has closed.
  const [savedDone, setSavedDone] = useState<ReadonlySet<string>>(() => new Set());
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [phases, setPhases] = useState<Readonly<Record<string, DonePhase>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const timers = useRef(new Map<string, number[]>());

  useEffect(() => {
    if (api === null) return;
    let cancelled = false;
    api
      .listBriefItemCompletions()
      .then(keys => {
        if (!cancelled) setSavedDone(new Set(keys));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const ids of pending.values()) ids.forEach(id => window.clearTimeout(id));
    };
  }, []);

  const hiddenKeys = new Set([...savedDone, ...closedKeys]);
  const view = buildBriefView({ brief, hiddenKeys, expanded });
  const total = view.sections.reduce((sum, section) => sum + section.count, 0);
  const isDone = (key: string): boolean => phases[key] !== undefined;

  function setPhase(key: string, phase: DonePhase | undefined) {
    setPhases(current => {
      const next = { ...current };
      if (phase === undefined) delete next[key];
      else next[key] = phase;
      return next;
    });
  }

  function clearTimers(key: string) {
    timers.current.get(key)?.forEach(id => window.clearTimeout(id));
    timers.current.delete(key);
  }

  function markDone(item: BriefViewItem) {
    // Without the chat there is nowhere to record the mark, so the row stays as it is.
    if (api !== null && sessionId === undefined) return;
    setFailure(null);
    setPhase(item.key, 'fading');
    const fade = prefersReducedMotion() ? 0 : DONE_FADE_MS;
    const showUndo = window.setTimeout(() => setPhase(item.key, 'undo'), fade);
    const close = window.setTimeout(() => {
      setPhases(current => {
        const next = { ...current };
        delete next[item.key];
        return next;
      });
      setClosedKeys(current => new Set(current).add(item.key));
      timers.current.delete(item.key);
    }, fade + UNDO_WINDOW_MS);
    timers.current.set(item.key, [showUndo, close]);
    if (api !== null && sessionId !== undefined) {
      api.markBriefItemDone({ itemKey: item.key, section: item.section, title: item.title, sessionId }).catch(() => {
        clearTimers(item.key);
        setPhase(item.key, undefined);
        setFailure('Could not save that. Try again.');
      });
    }
  }

  function undo(key: string) {
    clearTimers(key);
    setPhase(key, undefined);
    api?.unmarkBriefItemDone(key).catch(() => {
      setFailure('Could not undo that. Try again.');
    });
  }

  return (
    <div className="flex w-full max-w-[48rem] flex-col gap-4" data-testid="aman-brief">
      <header className="flex flex-col gap-1">
        <h2
          id={`${briefId}-greeting`}
          className="font-serif text-2xl font-normal leading-tight text-text-primary sm:text-[1.75rem]"
        >
          {greetingLine({ now: new Date(), name })}
        </h2>
        <p className="text-base text-text-secondary">{brief.digest}</p>
      </header>

      <div className="aui-brief-card flex flex-col px-4 py-4 sm:px-5">
        {view.sections.map(section => (
          <BriefSectionBlock
            key={section.section}
            section={section}
            isDone={isDone}
            phases={phases}
            onDone={markDone}
            onUndo={undo}
          />
        ))}
        {total === 0 && omittedCount === 0 ? (
          <p className="text-base text-text-secondary">Nothing needs you this morning.</p>
        ) : null}
        {view.hiddenCount > 0 || expanded ? (
          <button
            type="button"
            className="aui-brief-action mt-2 self-start"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? 'Show fewer'
              : `+ ${String(view.hiddenCount)} more ${view.hiddenCount === 1 ? 'item' : 'items'}`}
          </button>
        ) : null}
        {failure === null ? null : (
          <p role="alert" className="mt-2 text-sm text-text-secondary">
            {failure}
          </p>
        )}
      </div>

      {omittedCount > 0 ? (
        <p data-testid="brief-omitted" className="text-sm text-text-secondary">
          {briefOmittedLine(omittedCount)}
        </p>
      ) : null}

      <BriefFooter sessionId={sessionId} />
    </div>
  );
}

function BriefSectionBlock({
  section,
  isDone,
  phases,
  onDone,
  onUndo,
}: {
  section: BriefViewSection;
  isDone: (key: string) => boolean;
  phases: Readonly<Record<string, DonePhase>>;
  onDone: (item: BriefViewItem) => void;
  onUndo: (key: string) => void;
}) {
  const isCheck = section.section === 'check_first';
  const heading = section.section === 'decision' ? `${section.label} · ${String(section.count)}` : section.label;
  return (
    <section className="mt-6 flex flex-col gap-2 first:mt-0" aria-label={heading}>
      <h3 className={cn('text-sm font-normal', isCheck ? 'text-gold-ink' : 'text-text-secondary')}>{heading}</h3>
      <ul className="flex flex-col">
        {section.items.map(item => (
          <BriefRow
            key={item.key}
            item={item}
            phase={phases[item.key]}
            done={isDone(item.key)}
            onDone={onDone}
            onUndo={onUndo}
          />
        ))}
      </ul>
    </section>
  );
}

function BriefRow({
  item,
  phase,
  done,
  onDone,
  onUndo,
}: {
  item: BriefViewItem;
  phase: DonePhase | undefined;
  done: boolean;
  onDone: (item: BriefViewItem) => void;
  onUndo: (key: string) => void;
}) {
  const sendPrompt = useSendPrompt();
  const isCheck = item.section === 'check_first';
  const subtitle = item.subtitle.join(' · ');
  const when = item.section === 'coming_up' && item.when !== undefined ? briefWhenLabel(item.when) : undefined;
  const { action } = item;
  const target = action.target;
  const actionPlace = 'col-start-2 justify-self-start sm:col-start-3 sm:row-start-1 sm:justify-self-end';
  const actionClass = cn('aui-brief-action', actionPlace);

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    if (event.target !== event.currentTarget || done) return;
    if (event.key === ' ') {
      event.preventDefault();
      onDone(item);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.querySelector<HTMLElement>('[data-brief-action]')?.click();
    }
  }

  return (
    <li
      tabIndex={0}
      data-testid="brief-row"
      aria-label={item.title}
      onKeyDown={onKeyDown}
      className={cn(
        'group/row grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-border py-2.5 first:border-t-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-ink sm:grid-cols-[1.25rem_minmax(0,1fr)_max-content]',
        phase === 'fading' && 'opacity-0 transition-opacity duration-[225ms] ease-out',
      )}
    >
      {isCheck ? (
        <span className="flex size-[1.25rem] items-center justify-center self-start pt-[0.125rem]">
          <span aria-hidden="true" className="size-[0.6875rem] rounded-full bg-gold ring-1 ring-gold-ink" />
        </span>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Mark done: ${item.title}`}
          disabled={done}
          onClick={() => onDone(item)}
          className="flex size-[1.25rem] cursor-pointer items-center justify-center self-start border-0 bg-transparent p-0 pt-[0.125rem] disabled:cursor-default"
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-[0.8125rem] rounded-full border border-text-secondary',
              'group-hover/row:hidden group-focus-visible/row:hidden',
              done && 'hidden',
            )}
          />
          <span
            aria-hidden="true"
            className={cn('hidden size-[1.25rem] group-hover/row:block group-focus-visible/row:block', done && 'block')}
          >
            <GoldTick play={phase !== undefined} className="size-full" />
          </span>
        </button>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            'line-clamp-2 break-words text-base font-medium leading-snug text-text-primary sm:line-clamp-1',
            done && 'text-text-secondary',
          )}
        >
          {item.title}
        </span>
        {when === undefined && subtitle === '' && item.source === undefined ? null : (
          <span className="flex min-w-0 items-baseline gap-x-2 text-sm leading-snug text-text-secondary">
            {when === undefined ? null : <span className="shrink-0 font-receipt text-xs">{when}</span>}
            {subtitle === '' ? null : <span className="min-w-0 truncate">{subtitle}</span>}
            {item.source === undefined ? null : (
              <span data-testid="brief-source" className="aui-brief-source shrink-0">
                {item.source}
              </span>
            )}
          </span>
        )}
      </span>
      {phase === 'undo' ? (
        <button type="button" className={actionClass} onClick={() => onUndo(item.key)}>
          Undo
        </button>
      ) : target.kind === 'link' ? (
        // The brief is written from mail anyone can send, so its web addresses never become links.
        <span
          data-testid="brief-link-site"
          className={cn(actionPlace, 'whitespace-nowrap text-sm text-text-secondary')}
        >
          {new URL(target.url).hostname}
        </span>
      ) : (
        <button data-brief-action type="button" className={actionClass} onClick={() => sendPrompt(target.text)}>
          {action.label}
        </button>
      )}
    </li>
  );
}

/** The trust line from real audit counts, read once when the brief has loaded. */
function BriefFooter({ sessionId }: { sessionId: string | undefined }) {
  const sentinel = useOptionalSentinelApiState();
  const api = sentinel?.api ?? null;
  const [summary, setSummary] = useState<BriefAuditSummary | null>(null);

  useEffect(() => {
    if (api === null || sessionId === undefined) return;
    let cancelled = false;
    api
      .listAuditEntries({ sessionId, limit: 200 })
      .then(entries => {
        if (!cancelled) setSummary(summarizeBriefAudit(entries));
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  if (summary === null) return null;
  return <p className="text-sm text-text-secondary">{briefFooterLine(summary)}</p>;
}
