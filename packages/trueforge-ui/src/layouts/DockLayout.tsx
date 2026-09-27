'use client';

import { cn } from '../atoms/lib/cn.js';
import { CompactLayoutProvider } from '../atoms/lib/CompactLayoutContext.js';
import { StackChatPanel } from './StackChatPanel.js';

/** Fixed-width right panel with list ↔ thread stack navigation. */
export function DockLayout({ className }: { className?: string }) {
  return (
    <CompactLayoutProvider>
      <div
        data-aui-compact-layout
        className={cn(
          // No hairline border: the panel floats above the chat surface, separated
          // by a soft directional shadow instead of a hard divider line.
          'ml-auto flex h-full w-full max-w-[min(400px,100%)] min-h-0 min-w-0 flex-col bg-primary-bg shadow-[-12px_0_32px_-12px_color-mix(in_oklab,var(--shadow-color)_12%,transparent)]',
          className,
        )}
      >
        <StackChatPanel />
      </div>
    </CompactLayoutProvider>
  );
}
