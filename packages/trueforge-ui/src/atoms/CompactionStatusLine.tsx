'use client';

import { TOKEN_BUDGET_SAFETY_MARGIN } from '@truefoundry/trueforge-core/core/capabilities/builtins/tokenBudgetConstants';
import { useCompactionStatus } from '../hooks/useCompactionStatus.js';
import { cn } from './lib/cn.js';

/** Formats a token count compactly: 12500 -> "12.5k", 800 -> "800". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands).toString() : thousands.toFixed(1)}k`;
  }
  return String(Math.round(tokens));
}

/** Human relative time: "2h ago", "3d ago", "just now". */
export function formatRelativeTime(isoTimestamp: string, nowMs: number = Date.now()): string {
  const thenMs = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(thenMs)) return '';
  const diffMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

/**
 * One-line status under the chat composer: current context usage and the
 * most recent compaction outcome. Minimal and unobtrusive; renders nothing
 * while the status is still loading or when no model context limit is known
 * and no compaction has ever run.
 *
 * When the context limit and live token count are known, shows a thin
 * stacked bar breaking the window into input used, output reserved, and
 * free budget.
 */
export function CompactionStatusLine({ className }: { className?: string }) {
  const { contextLimit, liveTokens, maxOutputTokens, lastCompaction, loading } = useCompactionStatus();

  if (loading) return null;
  if (lastCompaction == null && contextLimit == null && liveTokens == null) return null;

  const parts: string[] = [];

  // Token budget breakdown, when the limit, live count, and output
  // reservation are all known. The free budget subtracts the backend's
  // safety margin so the UI reflects the actual usable headroom.
  const budget =
    contextLimit != null && contextLimit > 0 && liveTokens != null && maxOutputTokens != null
      ? {
          limit: contextLimit,
          input: liveTokens,
          output: maxOutputTokens,
          free: Math.max(0, contextLimit - liveTokens - maxOutputTokens - TOKEN_BUDGET_SAFETY_MARGIN),
        }
      : null;

  if (budget != null) {
    parts.push(
      `${formatTokenCount(budget.input)} / ${formatTokenCount(budget.limit)} input · ` +
        `${formatTokenCount(budget.output)} output · ` +
        `${formatTokenCount(budget.free)} free`,
    );
  } else if (contextLimit != null) {
    const usage =
      liveTokens != null
        ? `${formatTokenCount(liveTokens)} / ${formatTokenCount(contextLimit)} tokens`
        : `${formatTokenCount(contextLimit)} token limit`;
    parts.push(usage);
  } else if (liveTokens != null) {
    parts.push(`${formatTokenCount(liveTokens)} tokens in context`);
  }

  if (lastCompaction != null) {
    const when = formatRelativeTime(lastCompaction.createdAt);
    if (lastCompaction.outcome === 'applied') {
      // The saved-tokens number is dropped: tokensBefore is a provider count
      // and tokensAfter is a text estimate, so their difference overstates.
      parts.push(`Compacted ${when}`);
    } else if (lastCompaction.outcome === 'truncated_fallback') {
      parts.push(`Shortened history ${when} to fit`);
    } else if (lastCompaction.outcome !== 'skipped_blocked') {
      // skipped_blocked means the user cancelled the turn, which is not a failure.
      parts.push(`Compaction failed ${when}`);
    }
  }

  if (parts.length === 0) return null;

  return (
    <div
      data-slot="aui_compaction-status"
      className={cn('px-1 pt-1 text-[0.6875rem] leading-tight text-text-secondary/70', className)}
    >
      <div>{parts.join(' · ')}</div>
      {budget != null && (
        <div
          className="mt-1 h-1 overflow-hidden rounded-full bg-secondary-bg"
          role="img"
          aria-label={
            `${formatTokenCount(budget.input)} of ${formatTokenCount(budget.limit)} input tokens used, ` +
            `${formatTokenCount(budget.output)} reserved for output, ` +
            `${formatTokenCount(budget.free)} free`
          }
        >
          <div className="flex h-full">
            <div
              className="h-full shrink-0 bg-primary-button-bg"
              style={{ width: `${(budget.input / budget.limit) * 100}%` }}
            />
            <div
              className="h-full shrink-0 bg-text-secondary/40"
              style={{ width: `${(budget.output / budget.limit) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
