'use client';

import { cn } from './lib/cn.js';

export type ApprovalNavBannerProps = {
  total: number;
  /** The name the person chose for the assistant. */
  assistantName: string;
  /** Title of the first pending card, e.g. "Send this reply?". */
  title?: string;
  /** Scroll the thread to the first pending card and focus its main button. */
  onFocusCurrent: () => void;
  className?: string;
};

/** The strip's words: one item names the assistant (its card title follows), several count the items. */
export function approvalBannerLabel({ total, assistantName }: { total: number; assistantName: string }): string {
  if (total !== 1) return `${String(total)} things are waiting for your OK`;
  return `${assistantName} is waiting for your OK:`;
}

/** Docked to the top of the composer while a pending card is off screen; one box with the composer. */
export function ApprovalNavBanner({ total, assistantName, title, onFocusCurrent, className }: ApprovalNavBannerProps) {
  const label = approvalBannerLabel({ total, assistantName });

  return (
    <div
      data-slot="aui_approval-nav-banner"
      role="status"
      aria-live="polite"
      className={cn(
        'aui-approval-nav-banner border-gold-line bg-gold-soft text-text-primary flex w-full items-center gap-2 rounded-t-[1.25rem] border-t border-r border-l px-4 py-2 text-[0.8125rem]',
        className,
      )}
    >
      <span className="bg-gold size-1.5 shrink-0 rounded-full" aria-hidden />
      <p className="min-w-0 flex-1">
        {label}
        {total === 1 && title !== undefined ? <span className="font-serif text-[0.9375rem]"> {title}</span> : null}
      </p>
      <button
        type="button"
        onClick={onFocusCurrent}
        className="text-gold-ink shrink-0 rounded-sm border-0 bg-transparent p-0 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
      >
        Review ↑
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ApprovalNavBanner: typeof ApprovalNavBanner;
  }
}
