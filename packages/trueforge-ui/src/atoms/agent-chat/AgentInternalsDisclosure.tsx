'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type AgentInternalsDisclosureProps = {
  /** One-line summary like "2 steps · 2 tools" shown on the toggle. */
  summary: string;
  /** Live label for screen readers during streaming, e.g. "Executing tools…". */
  liveLabel?: string;
  /** Whether the message is currently streaming/running. */
  isRunning?: boolean;
  /** Show an amber attention dot (errors, approval waits) and auto-expand. */
  attention?: boolean;
  /** When true, stays expanded with no collapse toggle (e.g. pending approval). */
  lockOpen?: boolean;
  /** Expanded by default (user preference). */
  defaultExpanded?: boolean;
  /** Show the "Always show agent details" preference checkbox. */
  showPreferenceToggle?: boolean;
  /** Current value of the "always show" preference. */
  preferenceOn?: boolean;
  /** Called when the preference checkbox changes. */
  onPreferenceChange?: (value: boolean) => void;
  /** Prefix for data-testid attributes (tests). */
  dataTestPrefix?: string;
  /** The internals content (tool cards, reasoning, intermediate text). */
  children: ReactNode;
};

/**
 * Progressive disclosure for agent internals (tool calls, reasoning steps,
 * intermediate text). Completed turns collapse to a faint one-line summary;
 * errors and approval waits get an amber dot and auto-expand.
 */
export function AgentInternalsDisclosure({
  summary,
  liveLabel,
  isRunning = false,
  attention = false,
  lockOpen = false,
  defaultExpanded = false,
  showPreferenceToggle = false,
  preferenceOn = false,
  onPreferenceChange,
  dataTestPrefix = 'agent-internals',
  children,
}: AgentInternalsDisclosureProps): ReactNode {
  const [expanded, setExpanded] = useState(defaultExpanded || lockOpen);
  const userDrivenRef = useRef(false);
  const attentionSeenRef = useRef(false);

  // Auto-expand on attention (errors, approvals) once; auto-collapse when
  // the run finishes unless the user manually toggled. Locked-open stays
  // expanded with no toggle.
  useEffect(() => {
    if (lockOpen) {
      setExpanded(true);
      return;
    }
    if (attention) {
      if (!attentionSeenRef.current) {
        attentionSeenRef.current = true;
        setExpanded(true);
      }
    } else {
      attentionSeenRef.current = false;
      if (!isRunning && !userDrivenRef.current && !defaultExpanded) {
        setExpanded(false);
      }
    }
  }, [attention, isRunning, defaultExpanded, lockOpen]);

  // Follow the "Always show agent details" preference: when defaultExpanded
  // changes after mount, reflect it unless the user has manually toggled the
  // disclosure themselves. Locked-open stays expanded regardless.
  const defaultExpandedRef = useRef(defaultExpanded);
  useEffect(() => {
    if (lockOpen || userDrivenRef.current) return;
    if (defaultExpandedRef.current === defaultExpanded) return;
    defaultExpandedRef.current = defaultExpanded;
    setExpanded(defaultExpanded);
  }, [defaultExpanded, lockOpen]);

  const toggle = () => {
    userDrivenRef.current = true;
    setExpanded(prev => !prev);
  };

  const toggleTestId = `${dataTestPrefix}-agent-internals-toggle`;
  const attentionTestId = `${dataTestPrefix}-agent-internals-attention`;
  const spinnerTestId = `${dataTestPrefix}-agent-internals-live-spinner`;

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
        {lockOpen ? (
          <span className="text-xs text-text-tertiary">
            {liveLabel != null ? (
              <>
                {liveLabel}
                <span className="ml-1.5 opacity-70">{summary}</span>
              </>
            ) : (
              summary
            )}
          </span>
        ) : (
          <button
            type="button"
            data-testid={toggleTestId}
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse agent details' : 'Expand agent details'}
            className="flex items-center gap-1 rounded text-xs text-text-tertiary transition-colors hover:text-text-secondary"
          >
            <span>{isRunning && liveLabel != null ? liveLabel : summary}</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {isRunning && liveLabel != null && (
          <span
            data-testid={spinnerTestId}
            aria-hidden="true"
            className="inline-block size-3 animate-spin rounded-full border border-text-tertiary border-t-transparent"
          />
        )}
        {showPreferenceToggle && (
          <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-text-tertiary">
            <input
              type="checkbox"
              checked={preferenceOn}
              onChange={event => onPreferenceChange?.(event.target.checked)}
              className="size-3 accent-current"
            />
            Always show agent details
          </label>
        )}
      </div>
      <div hidden={!expanded} className="mt-1">
        {children}
      </div>
    </div>
  );
}
