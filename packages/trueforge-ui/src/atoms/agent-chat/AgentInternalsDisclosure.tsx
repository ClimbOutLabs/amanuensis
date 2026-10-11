'use client';

import type { ReactNode } from 'react';

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
  /** The chat-level "Show agent details" switch. Content also renders when `lockOpen` is set, or when `attention` is set while the turn is running. */
  expanded: boolean;
  /** Prefix for data-testid attributes (tests). */
  dataTestPrefix?: string;
  /** The internals content (tool cards, reasoning, intermediate text). */
  children: ReactNode;
};

/**
 * Agent internals (tool calls, reasoning steps, intermediate text) for one turn. Whether the
 * content renders is the chat-level "Show agent details" switch (`expanded`). Two live-turn
 * exceptions keep the content visible regardless of the switch: `lockOpen` (a pending approval
 * needs its action buttons visible) and `attention` while the turn is running (an error on the
 * active turn stays in view). Once the turn completes, errors are signaled by the amber
 * attention dot and the summary row only — the content follows the switch. There is no per-turn
 * expand control.
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
  const contentVisible = expanded || (attention && isRunning) || lockOpen;

  return (
    <div data-testid={`${dataTestPrefix}-agent-internals`} role="region" aria-label={summary} className="mt-1">
      <div className="flex items-center gap-1.5">
        {attention && (
          <span
            data-testid={attentionTestId}
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-warning-bg"
          />
        )}
        <span className="text-xs text-text-tertiary">
          {liveLabel != null && (isRunning || lockOpen) ? (
            <>
              {liveLabel}
              <span className="ml-1.5 opacity-70">{summary}</span>
            </>
          ) : (
            summary
          )}
        </span>
        {isRunning && liveLabel != null && (
          <span
            data-testid={spinnerTestId}
            aria-hidden="true"
            className="inline-block size-3 animate-spin rounded-full border border-text-tertiary border-t-transparent"
          />
        )}
      </div>
      <div hidden={!contentVisible} className="mt-1">
        {children}
      </div>
    </div>
  );
}
