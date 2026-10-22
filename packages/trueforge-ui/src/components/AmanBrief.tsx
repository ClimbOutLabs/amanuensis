'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { GoldTick, Highlight } from '../atoms/Reward.js';
import { useRewardLedger, type RewardContext } from '../hooks/useRewardLedger.js';
import { useSendPrompt } from '../hooks/useSendPrompt.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import {
  briefFooterLine,
  briefGreeting,
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

/** The highlight plays once, on the first Check first title, as the card arrives. */
const HIGHLIGHT_START_MS = 350;
/** The fade a done row takes before its Undo shows. */
const DONE_FADE_MS = 225;
/** How long Undo stays in a row's place. */
const UNDO_WINDOW_MS = 5000;

/** The brief page only renders once the answer is done, so nothing blocks a reward here. */
const QUIET_CONTEXT: RewardContext = {
  busy: false,
  waitingOnPerson: false,
  hasError: false,
  scheduleFailedToday: false,
};

export type AmanBriefProps = {
  brief: MorningBrief;
  /** Identifies this brief for the highlight cap. */
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
export function AmanBrief({ brief, briefId, sessionId }: AmanBriefProps) {
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
  const firstCheck = view.sections.find(section => section.section === 'check_first')?.items[0];
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
    <div className="flex w-full max-w-[48rem] flex-col gap-6" data-testid="aman-brief">
      <header className="flex flex-col gap-2">
        <h2 id={`${briefId}-greeting`} className="font-serif text-[1.75rem] font-normal text-text-primary">
          {briefGreeting({ now: new Date(), name })}
        </h2>
        <p className="text-text-secondary">{brief.digest}</p>
      </header>

      <div className="aui-brief-card flex flex-col gap-5 p-5">
        {view.sections.map(section => (
          <BriefSectionBlock
            key={section.section}
            section={section}
            isDone={isDone}
            phases={phases}
            highlightKey={firstCheck?.key ?? null}
            briefId={briefId}
            onDone={markDone}
            onUndo={undo}
          />
        ))}
        {total === 0 ? <p className="text-text-secondary">Nothing needs you this morning.</p> : null}
        {view.hiddenCount > 0 || expanded ? (
          <button
            type="button"
            className="self-start text-[0.875rem] text-text-secondary underline underline-offset-2"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? 'Show fewer'
              : `+ ${String(view.hiddenCount)} more ${view.hiddenCount === 1 ? 'item' : 'items'}`}
          </button>
        ) : null}
        {failure === null ? null : (
          <p role="alert" className="text-[0.875rem] text-text-secondary">
            {failure}
          </p>
        )}
      </div>

      <BriefFooter sessionId={sessionId} />
    </div>
  );
}

function BriefSectionBlock({
  section,
  isDone,
  phases,
  highlightKey,
  briefId,
  onDone,
  onUndo,
}: {
  section: BriefViewSection;
  isDone: (key: string) => boolean;
  phases: Readonly<Record<string, DonePhase>>;
  highlightKey: string | null;
  briefId: string;
  onDone: (item: BriefViewItem) => void;
  onUndo: (key: string) => void;
}) {
  const isCheck = section.section === 'check_first';
  const heading = section.section === 'decision' ? `${section.label} · ${String(section.count)}` : section.label;
  return (
    <section className="flex flex-col gap-1" aria-label={heading}>
      <h3 className={cn('text-[0.8125rem] font-normal', isCheck ? 'text-gold-ink' : 'text-text-secondary')}>
        {heading}
      </h3>
      <ul className="flex flex-col">
        {section.items.map(item => (
          <BriefRow
            key={item.key}
            item={item}
            phase={phases[item.key]}
            highlight={item.key === highlightKey}
            briefId={briefId}
            done={isDone(item.key)}
            onDone={onDone}
            onUndo={onUndo}
          />
        ))}
      </ul>
    </section>
  );
}

/** Plays the Check first highlight once, after the card arrives. */
function useHighlightPlay({ briefId, enabled }: { briefId: string; enabled: boolean }): boolean {
  const { tryPlay } = useRewardLedger();
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      if (tryPlay({ request: { kind: 'highlight', briefId }, context: QUIET_CONTEXT })) setPlay(true);
    }, HIGHLIGHT_START_MS);
    return () => window.clearTimeout(timer);
  }, [briefId, enabled, tryPlay]);
  return play;
}

function BriefRow({
  item,
  phase,
  highlight,
  briefId,
  done,
  onDone,
  onUndo,
}: {
  item: BriefViewItem;
  phase: DonePhase | undefined;
  highlight: boolean;
  briefId: string;
  done: boolean;
  onDone: (item: BriefViewItem) => void;
  onUndo: (key: string) => void;
}) {
  const sendPrompt = useSendPrompt();
  const actionRef = useRef<HTMLButtonElement>(null);
  const playHighlight = useHighlightPlay({ briefId, enabled: highlight });
  const isCheck = item.section === 'check_first';
  const isComing = item.section === 'coming_up';
  const subtitle = item.subtitle.join(' · ');
  const when = item.section === 'coming_up' && item.when !== undefined ? briefWhenLabel(item.when) : undefined;
  const { action } = item;

  function runAction() {
    if (action.target.kind === 'prompt') {
      sendPrompt(action.target.text);
    } else {
      window.open(action.target.url, '_blank', 'noopener,noreferrer');
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>) {
    if (event.target !== event.currentTarget || done) return;
    if (event.key === ' ') {
      event.preventDefault();
      onDone(item);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      actionRef.current?.click();
    }
  }

  const titleText = (
    <span
      className={cn(
        'line-clamp-2 break-words text-[1.0625rem] font-medium text-text-primary sm:line-clamp-none sm:block sm:truncate',
        done && 'text-text-secondary',
      )}
    >
      {highlight ? <Highlight play={playHighlight}>{item.title}</Highlight> : item.title}
    </span>
  );

  return (
    <li
      tabIndex={0}
      data-testid="brief-row"
      aria-label={item.title}
      onKeyDown={onKeyDown}
      className={cn(
        'group/row grid items-center gap-x-3 border-t border-border py-3 first:border-t-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-ink',
        isComing
          ? 'grid-cols-[1.25rem_3.75rem_minmax(0,1fr)] sm:grid-cols-[1.25rem_3.75rem_minmax(0,1fr)_max-content]'
          : 'grid-cols-[1.25rem_minmax(0,1fr)] sm:grid-cols-[1.25rem_minmax(0,1fr)_max-content]',
        phase === 'fading' && 'opacity-0 transition-opacity duration-[225ms] ease-out',
      )}
    >
      <span className="relative flex size-[1.25rem] items-center justify-center">
        {isCheck ? (
          <span aria-hidden="true" className="size-[0.6875rem] rounded-full bg-gold ring-1 ring-gold-ink" />
        ) : (
          <>
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
              className={cn(
                'hidden size-[1.25rem] group-hover/row:block group-focus-visible/row:block',
                done && 'block',
              )}
            >
              <GoldTick play={phase !== undefined} className="size-full" />
            </span>
          </>
        )}
      </span>
      {isComing ? <span className="font-receipt text-[0.74rem] text-text-secondary">{when ?? ''}</span> : null}
      <span className="min-w-0">
        {titleText}
        {subtitle === '' ? null : (
          <span className="block truncate text-[0.875rem] text-text-secondary">{subtitle}</span>
        )}
      </span>
      {phase === 'undo' ? (
        <button
          type="button"
          className={cn(
            'justify-self-start text-[0.875rem] whitespace-nowrap text-gold-ink underline underline-offset-2 sm:justify-self-end sm:col-start-auto',
            isComing ? 'col-start-3' : 'col-start-2',
          )}
          onClick={() => onUndo(item.key)}
        >
          Undo
        </button>
      ) : (
        <button
          ref={actionRef}
          type="button"
          className={cn(
            'justify-self-start text-[0.875rem] whitespace-nowrap text-gold-ink underline underline-offset-2 sm:justify-self-end sm:col-start-auto',
            isComing ? 'col-start-3' : 'col-start-2',
          )}
          onClick={runAction}
          aria-label={action.label}
        >
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
  return <p className="text-[0.875rem] text-text-secondary">{briefFooterLine(summary)}</p>;
}
