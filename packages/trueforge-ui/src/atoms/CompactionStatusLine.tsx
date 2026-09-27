'use client';

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
 */
export function CompactionStatusLine({ className }: { className?: string }) {
  const { contextLimit, liveTokens, lastCompaction, loading } = useCompactionStatus();

  if (loading) return null;
  if (lastCompaction == null && contextLimit == null && liveTokens == null) return null;

  const parts: string[] = [];

  if (contextLimit != null) {
    const usage =
      liveTokens != null
        ? `${formatTokenCount(liveTokens)} / ${formatTokenCount(contextLimit)} tokens`
        : `${formatTokenCount(contextLimit)} token limit`;
    parts.push(usage);
  } else if (liveTokens != null) {
    parts.push(`${formatTokenCount(liveTokens)} tokens`);
  }

  if (lastCompaction != null) {
    const when = formatRelativeTime(lastCompaction.createdAt);
    if (lastCompaction.outcome === 'applied') {
      const saved = Math.max(0, lastCompaction.tokensBefore - lastCompaction.tokensAfter);
      parts.push(`Compacted ${when}, saved ${formatTokenCount(saved)} tokens`);
    } else {
      parts.push(`Compaction failed ${when}`);
    }
  }

  if (parts.length === 0) return null;

  return (
    <div
      data-slot="aui_compaction-status"
      className={cn('px-1 pt-1 text-[0.6875rem] leading-tight text-text-secondary/70', className)}
    >
      {parts.join(' · ')}
    </div>
  );
}
