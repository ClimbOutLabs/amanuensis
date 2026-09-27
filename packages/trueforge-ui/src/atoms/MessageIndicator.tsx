'use client';

import { useWaitQueue } from '../hooks/useWaitQueue.js';
import { WaitQueueIndicator } from './WaitQueueIndicator.js';
import { cn } from './lib/cn.js';

export type MessageIndicatorProps = {
  className?: string;
};

/**
 * Slot entry for the assistant's "waiting" indicator. Now renders the wait
 * queue (Listening → Remembering → Doing → Writing) driven by real turn
 * events; host slot overrides keep working unchanged.
 */
export function MessageIndicator({ className }: MessageIndicatorProps) {
  const { snapshot, elapsedMs, reducedMotion } = useWaitQueue();
  return (
    <span
      data-slot="aui_assistant-message-indicator"
      className={cn('inline-flex items-center font-sans text-sm text-text-secondary', className)}
    >
      <WaitQueueIndicator snapshot={snapshot} elapsedMs={elapsedMs} reducedMotion={reducedMotion} />
    </span>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    MessageIndicator: typeof MessageIndicator;
  }
}
