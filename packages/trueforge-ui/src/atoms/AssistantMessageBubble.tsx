import type { ReactNode } from 'react';

import { cn } from './lib/cn.js';

export type AssistantMessageBubbleProps = {
  children: ReactNode;
  error?: ReactNode;
  actionBar?: ReactNode;
  className?: string;
};

export function AssistantMessageBubble({ children, error, actionBar, className }: AssistantMessageBubbleProps) {
  return (
    <div
      data-slot="aui_assistant-message-root"
      className={cn(
        'aman-chat-text group/assistant relative max-w-full min-w-0 text-assistant-message-text',
        className,
      )}
    >
      <div className="min-w-0 max-w-full">
        {children}
        {error && <div className="mt-2 text-sm text-failure-bg">{error}</div>}
      </div>
      {actionBar && <div className="mt-1">{actionBar}</div>}
    </div>
  );
}

export type AssistantTextCardProps = {
  children: ReactNode;
};

/**
 * The soft paper card behind a written reply. Only prose sits on it: approval cards, the brief and
 * status lines already carry their own frame and stay on the page. One tighter corner marks the
 * side the reply comes from, and the card hides while its text is still empty.
 */
export function AssistantTextCard({ children }: AssistantTextCardProps) {
  return (
    <div
      data-slot="aui_assistant-text-card"
      className="border-border rounded-[var(--composer-radius,1.25rem)] rounded-tl-[0.375rem] border bg-assistant-message-bg px-3 py-2.5 shadow-[var(--shadow-raise)] not-first:mt-2 not-last:mb-2 sm:px-4 sm:py-3 [&:not(:has(.aui-markdown>*))]:hidden"
    >
      {children}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    AssistantMessageBubble: typeof AssistantMessageBubble;
  }
}
