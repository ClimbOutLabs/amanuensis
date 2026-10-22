'use client';

import { useEffect, useId, useMemo, useState } from 'react';

import { cn } from '../atoms/lib/cn.js';
import { Highlight } from '../atoms/Reward.js';
import { useHighlightedCard, useRewardLedger, type RewardContext } from '../hooks/useRewardLedger.js';
import { useSendPrompt } from '../hooks/useSendPrompt.js';
import { useOptionalSentinelApiState } from '../sentinel/SentinelApiContext.js';
import {
  summarizeBriefAudit,
  type BriefAuditSummary,
  type BriefLine,
  type BriefSection,
  type BriefSectionId,
} from './briefSections.js';

/** Lines under Watch out that may take a highlight, per brief. */
const MAX_HIGHLIGHTS = 3;
/** The highlights start after the line settles and step in one after another. */
const HIGHLIGHT_START_MS = 350;
const HIGHLIGHT_STEP_MS = 120;

/** The brief page only renders once the answer is done, so nothing blocks a reward here. */
const QUIET_CONTEXT: RewardContext = {
  busy: false,
  waitingOnPerson: false,
  hasError: false,
  scheduleFailedToday: false,
};

/** The mono count on each stop: the number of items in that chapter, in plain words. */
const STOP_COUNT_WORDS: Record<BriefSectionId, string> = {
  coming_up: 'coming up',
  deadlines: 'due',
  needs_doing: 'to do',
  watch_out: 'to check',
};

function sectionById(sections: readonly BriefSection[], id: BriefSectionId): BriefSection | undefined {
  return sections.find(section => section.id === id);
}

function stopCount(section: BriefSection): string {
  return `${String(section.lines.length)} ${STOP_COUNT_WORDS[section.id]}`;
}

function stopSecondLine(section: BriefSection): string {
  const first = section.lines[0];
  if (first === undefined) return 'Nothing here this time.';
  return first.text;
}

export type AmanBriefProps = {
  sections: readonly BriefSection[];
  /** Identifies this brief for the highlight cap. */
  briefId: string;
  /** The chat the brief came from, for the audit footer. */
  sessionId: string | undefined;
};

/** A brief answer as four stops and their chapters, with one tap per line and a footer from the audit log. */
export function AmanBrief({ sections, briefId, sessionId }: AmanBriefProps) {
  const prefix = useId();
  const comingUp = sectionById(sections, 'coming_up');
  const highlightedStop = useHighlightedCard({
    firstWaitingApprovalId: null,
    nextAppointmentId: comingUp !== undefined && comingUp.lines.length > 0 ? 'coming_up' : null,
  });

  return (
    <div className="flex flex-col gap-6" data-testid="aman-brief">
      <BriefStops sections={sections} highlightedId={highlightedStop} prefix={prefix} />
      <div className="flex flex-col">
        {sections.map(section => (
          <BriefChapter key={section.id} section={section} briefId={briefId} anchorId={`${prefix}-${section.id}`} />
        ))}
      </div>
      <BriefFooter sessionId={sessionId} />
    </div>
  );
}

function BriefStops({
  sections,
  highlightedId,
  prefix,
}: {
  sections: readonly BriefSection[];
  highlightedId: string | null;
  prefix: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="brief-stops">
      {sections.map(section => {
        const selected = highlightedId === section.id;
        return (
          <button
            key={section.id}
            type="button"
            data-testid={`brief-stop-${section.id}`}
            className={cn(
              'aui-ticket aui-ticket--punch flex flex-col gap-1 p-4 text-left',
              selected && 'aui-ticket--selected',
            )}
            onClick={() => document.getElementById(`${prefix}-${section.id}`)?.scrollIntoView({ block: 'start' })}
          >
            <span className="aui-brief-mono flex items-center gap-2 text-[0.68rem] tracking-[0.1em] text-text-secondary uppercase">
              {section.id === 'watch_out' && section.lines.length > 0 ? (
                <span aria-hidden="true" className="inline-block size-2 rounded-full bg-gold" />
              ) : null}
              {stopCount(section)}
            </span>
            <span className="aui-brief-display text-base font-semibold text-text-primary">{section.title}</span>
            <span className="text-sm text-text-secondary">{stopSecondLine(section)}</span>
          </button>
        );
      })}
    </div>
  );
}

function BriefChapter({ section, briefId, anchorId }: { section: BriefSection; briefId: string; anchorId: string }) {
  // Only Watch out lines are highlighted, the first few; the order sets when each sweep starts.
  const highlightOrder = useMemo(
    () =>
      new Map(
        section.id === 'watch_out'
          ? section.lines.slice(0, MAX_HIGHLIGHTS).map((line, order) => [line.id, order] as const)
          : [],
      ),
    [section],
  );
  return (
    <section id={anchorId} className="aui-chapter" aria-labelledby={`${anchorId}-title`}>
      <h3 id={`${anchorId}-title`} className="aui-brief-display pt-1 text-base font-semibold text-text-primary">
        {section.title}
      </h3>
      <ul className="flex flex-col gap-1">
        {section.lines.map(line => (
          <BriefRow key={line.id} line={line} briefId={briefId} highlightOrder={highlightOrder.get(line.id) ?? null} />
        ))}
      </ul>
    </section>
  );
}

/** Plays a line's highlight once, at its turn in the brief, if the ledger allows it. */
function useHighlightPlay({ briefId, order }: { briefId: string; order: number }): boolean {
  const { tryPlay } = useRewardLedger();
  const [play, setPlay] = useState(false);
  useEffect(() => {
    // The timer is cleared on cleanup, so a strict-mode double mount still plays once.
    const timer = window.setTimeout(
      () => {
        if (tryPlay({ request: { kind: 'highlight', briefId }, context: QUIET_CONTEXT })) setPlay(true);
      },
      HIGHLIGHT_START_MS + order * HIGHLIGHT_STEP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [briefId, order, tryPlay]);
  return play;
}

function HighlightedLineText({ text, briefId, order }: { text: string; briefId: string; order: number }) {
  const play = useHighlightPlay({ briefId, order });
  return <Highlight play={play}>{text}</Highlight>;
}

function BriefRow({
  line,
  briefId,
  highlightOrder,
}: {
  line: BriefLine;
  briefId: string;
  highlightOrder: number | null;
}) {
  const sendPrompt = useSendPrompt();
  const { action } = line;
  return (
    <li className="aui-row" data-testid="brief-row">
      <span className="mark flex items-center justify-center">
        <span aria-hidden="true" className="size-3 rounded-full border border-border" />
      </span>
      <span className="when" />
      <span className="text">
        {highlightOrder === null ? (
          line.text
        ) : (
          <HighlightedLineText text={line.text} briefId={briefId} order={highlightOrder} />
        )}
      </span>
      {action === null ? (
        <span className="action" />
      ) : (
        <button type="button" className="action" onClick={() => sendPrompt(`${action} for this: ${line.text}`)}>
          {action}
        </button>
      )}
    </li>
  );
}

function pluralize(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

/** The footer sentence. Only counts the audit log holds; nothing is claimed about sends it does not show. */
export function briefFooterLine(summary: BriefAuditSummary): string {
  const parts: string[] = [];
  if (summary.readAllowed > 0) parts.push(`${pluralize(summary.readAllowed, 'thing')} read, allowed by your settings.`);
  parts.push(summary.actionsRan === 0 ? 'Nothing was sent.' : `${pluralize(summary.actionsRan, 'action')} ran.`);
  return parts.join(' ');
}

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

/** The request a brief answers, shown as a ticket in place of the user's bubble. */
export function AmanBriefRequest() {
  return (
    <div className="aui-ticket aui-ticket--punch max-w-md p-4" data-testid="brief-request">
      <span className="aui-brief-display text-base font-semibold text-text-primary">Your morning brief</span>
    </div>
  );
}
