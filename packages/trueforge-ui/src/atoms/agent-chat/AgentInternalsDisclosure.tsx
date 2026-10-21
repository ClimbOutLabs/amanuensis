'use client';

import { useId, useState, type ReactNode } from 'react';

export type AgentInternalsDisclosureProps = {
  /** One-line summary like "2 steps · 2 tools" shown on the collapsed row. */
  summary: string;
  /** Live label for screen readers during streaming, e.g. "Executing tools…". */
  liveLabel?: string;
  /** Whether the message is currently streaming/running. */
  isRunning?: boolean;
  /**
   * Show an amber attention dot (errors, approval waits). While the turn is running this also
   * auto-expands the content so the problem stays in view; on a completed turn the dot stays but
   * the content follows `expanded`.
   */
  attention?: boolean;
  /** When true, always renders the content (e.g. a pending approval needs its action buttons visible). */
  lockOpen?: boolean;
  /** The chat-level "Show agent details" switch, the starting state of the per-answer toggle. Content also renders when `lockOpen` is set, or when `attention` is set while the turn is running. */
  expanded: boolean;
  /** Prefix for data-testid attributes (tests). */
  dataTestPrefix?: string;
  /** The internals content (tool cards, reasoning, intermediate text, model usage). */
  children: ReactNode;
};

/**
 * Agent internals (tool calls, reasoning steps, intermediate text, model usage) for one turn. The
 * summary row is a show/hide toggle that starts from the chat-level "Show agent details" switch
 * (`expanded`) and follows it again whenever the switch changes. Two live-turn exceptions keep the
 * content visible with no toggle: `lockOpen` (a pending approval needs its action buttons visible)
 * and `attention` while the turn is running (an error on the active turn stays in view). Once the
 * turn completes, errors are signaled by the amber attention dot and the summary row only.
 */
export function AgentInternalsDisclosure({
  summary,
  liveLabel,
  isRunning = false,
  attention = false,
  lockOpen = false,
  expanded,
  dataTestPrefix = 'agent-internals',
  children,
}: AgentInternalsDisclosureProps): ReactNode {
  const attentionTestId = `${dataTestPrefix}-agent-internals-attention`;
  const spinnerTestId = `${dataTestPrefix}-agent-internals-live-spinner`;
  const contentId = useId();
  const [toggle, setToggle] = useState({ open: expanded, from: expanded });
  // A change of the chat-level switch resets this answer's toggle to the new switch value.
  const open = toggle.from === expanded ? toggle.open : expanded;
  if (toggle.from !== expanded) setToggle({ open: expanded, from: expanded });
  const forcedOpen = (attention && isRunning) || lockOpen;
  const contentVisible = forcedOpen || open;
  const summaryText =
    liveLabel != null && (isRunning || lockOpen) ? (
      <>
        {liveLabel}
        <span className="ml-1.5 opacity-70">{summary}</span>
      </>
    ) : (
      summary
    );

  return (
    <div data-testid={`${dataTestPrefix}-agent-internals`} role="region" aria-label={summary} className="mt-1">
      <div className="flex items-center gap-1.5">
        {attention && (
          <span
            data-testid={attentionTestId}
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-warning"
          />
        )}
        {forcedOpen ? (
          <span className="text-xs text-text-tertiary">{summaryText}</span>
        ) : (
          <button
            type="button"
            data-testid={`${dataTestPrefix}-agent-internals-toggle`}
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setToggle({ open: !open, from: expanded })}
            className="m-0 cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left font-[inherit] text-xs text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50"
          >
            {summaryText}
          </button>
        )}
        {isRunning && liveLabel != null && (
          <span
            data-testid={spinnerTestId}
            aria-hidden="true"
            className="inline-block size-3 animate-spin rounded-full border border-text-tertiary border-t-transparent"
          />
        )}
      </div>
      <div id={contentId} hidden={!contentVisible} className="mt-1">
        {children}
      </div>
    </div>
  );
}
