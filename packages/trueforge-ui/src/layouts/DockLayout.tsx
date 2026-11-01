'use client';

import { cn } from '../atoms/lib/cn.js';
import { CompactLayoutProvider, useCompactContainerRef } from '../atoms/lib/CompactLayoutContext.js';
import { StackChatPanel } from './StackChatPanel.js';

/** Fixed-width right panel with list ↔ thread stack navigation. */
export function DockLayout({ className }: { className?: string }) {
  const compactContainerRef = useCompactContainerRef();
  return (
    <CompactLayoutProvider>
      <div
        data-aui-compact-layout
        ref={compactContainerRef}
        className={cn(
          // A shadow reads as a soft edge on light surfaces but vanishes on dark ones, so dark mode keeps the token border.
          'ml-auto flex h-full w-full max-w-[min(400px,100%)] min-h-0 min-w-0 flex-col bg-primary-bg shadow-[-0.75rem_0_2rem_-0.75rem_color-mix(in_oklab,var(--shadow-color)_12%,transparent)] dark:border-l dark:border-border',
          className,
        )}
      >
        <StackChatPanel />
      </div>
    </CompactLayoutProvider>
  );
}
