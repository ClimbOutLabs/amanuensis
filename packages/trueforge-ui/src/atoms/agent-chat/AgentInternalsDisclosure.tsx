'use client';

import type { ReactNode } from 'react';

export type AgentInternalsDisclosureProps = {
  /** One-line summary like "2 steps · 2 tools" shown on the collapsed row. */
  summary: string;
  /** Live label for screen readers during streaming, e.g. "Executing tools…". */
  liveLabel?: string;
  /** Whether the message is currently streaming/running. */
  isRunning?: boolean;
  /** Show an amber attention dot (errors, approval waits) and render the content. */
  attention?: boolean;
  /** When true, always renders the content (e.g. a pending approval needs its action buttons visible). */
  lockOpen?: boolean;
  /** The chat-level "Show agent details" switch. Content also renders when `attention` or `lockOpen` is set. */
  expanded: boolean;
  /** Prefix for data-testid attributes (tests). */
  dataTestPrefix?: string;
  /** The internals content (tool cards, reasoning, intermediate text). */
  children: ReactNode;
};

/**
 * Agent internals (tool calls, reasoning steps, intermediate text) for one turn. Whether the
 * content renders is entirely chat-level: the "Show agent details" switch (`expanded`), or an
 * error / approval wait on this turn (`attention`, `lockOpen`) so it stays visible and actionable
 * regardless of the switch. There is no per-turn expand control.
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
  const contentVisible = expanded || attention || lockOpen;

  return (
    <div data-testid={`${dataTestPrefix}-agent-internals`} role="region" aria-label={summary} className="mt-1">
      <div className="flex items-center gap-1.5">
        {attention && (
          <span
            data-testid={attentionTestId}
            aria-hidden="true"
            className="inline-block size-1.5 rounded-full bg-amber-500"
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
