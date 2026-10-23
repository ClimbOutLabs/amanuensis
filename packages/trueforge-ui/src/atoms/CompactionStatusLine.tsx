'use client';

import { useCompactionStatus } from '../hooks/useCompactionStatus.js';
import { cn } from './lib/cn.js';

/** Context share above which the chat says how full it is; below it the line stays hidden. */
const SHOW_ABOVE_SHARE = 0.8;

/**
 * One short line under the composer, shown only when the chat is more than 80% of its context.
 * Hidden while the status loads or when the context limit is not known.
 */
export function CompactionStatusLine({ className }: { className?: string }) {
  const { contextLimit, liveTokens, loading } = useCompactionStatus();

  if (loading || contextLimit == null || contextLimit <= 0 || liveTokens == null) return null;
  const share = liveTokens / contextLimit;
  if (share <= SHOW_ABOVE_SHARE) return null;

  return (
    <p data-slot="aui_compaction-status" className={cn('text-text-secondary px-1 pt-1 text-[0.8125rem]', className)}>
      {`This chat is ${String(Math.round(share * 100))}% full.`}
    </p>
  );
}
