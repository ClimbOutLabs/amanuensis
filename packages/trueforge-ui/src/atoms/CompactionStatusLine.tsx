'use client';

import { useCompactionStatus } from '../hooks/useCompactionStatus.js';
import type { LastCompactionStatus } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { formatTokenCount } from '../utils/sessionDisplayFormat.js';
import { cn } from './lib/cn.js';
import { formatRelativeTime } from './schedules/cadence.js';

const MEMORY_HINT = "How much of the model's memory this chat uses. When it fills up, older messages are shortened.";

/** How much of the model's memory the chat uses, or null when the chat's size is not known yet. */
export function memoryUseText({
  contextLimit,
  liveTokens,
}: {
  contextLimit: number | null;
  liveTokens: number | null;
}): string | null {
  if (liveTokens == null) return null;
  if (contextLimit == null || contextLimit <= 0) {
    return `This chat uses ${formatTokenCount(liveTokens)} tokens of the model's memory.`;
  }
  const percent = Math.round((liveTokens / contextLimit) * 100);
  return `This chat uses ${String(percent)}% of the model's memory (${formatTokenCount(liveTokens)} of ${formatTokenCount(contextLimit)} tokens).`;
}

/** The last time older messages were shortened, or null when it never ran or the person stopped it. */
function shortenedText(lastCompaction: LastCompactionStatus | null): string | null {
  if (lastCompaction == null || lastCompaction.outcome === 'skipped_blocked') return null;
  const when = formatRelativeTime(lastCompaction.createdAt);
  if (lastCompaction.outcome === 'applied' || lastCompaction.outcome === 'truncated_fallback') {
    return `Older messages were shortened ${when}.`;
  }
  return `Older messages could not be shortened ${when}.`;
}

/** One small muted line under the composer: how much of the model's memory this chat uses. */
export function CompactionStatusLine({ className }: { className?: string }) {
  const { contextLimit, liveTokens, lastCompaction, loading } = useCompactionStatus();

  if (loading) return null;
  const lines = [memoryUseText({ contextLimit, liveTokens }), shortenedText(lastCompaction)].filter(
    (line): line is string => line !== null,
  );
  if (lines.length === 0) return null;

  return (
    <p
      data-slot="aui_compaction-status"
      title={MEMORY_HINT}
      className={cn('px-1 pt-1 text-[0.75rem] leading-snug font-normal text-text-muted', className)}
    >
      {lines.join(' ')}
    </p>
  );
}
