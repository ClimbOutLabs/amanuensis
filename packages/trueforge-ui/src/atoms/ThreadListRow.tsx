'use client';

import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { auiButtonClass, sidebarQuietRadiusClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { formatRelativeShort } from './lib/threadListMeta.js';

export type ThreadListRowProps = {
  title: string;
  active: boolean;
  onSelect: () => void;
  /** Named-agent label under the title (from session.agentName). */
  agentName?: string;
  /** Shown as compact relative time on the right. */
  lastMessageAt?: Date;
  /** Something new came in that the person has not opened yet. */
  unread?: boolean;
  /** Overflow actions (e.g. delete menu) — rendered as a sibling of the title button. */
  actions?: ReactNode;
  className?: string;
};

export function ThreadListRow({
  title,
  active,
  onSelect,
  agentName,
  lastMessageAt,
  unread,
  actions,
  className,
}: ThreadListRowProps) {
  const relative = lastMessageAt != null ? formatRelativeShort(lastMessageAt) : undefined;
  const hasTrailing = relative != null || actions != null;

  return (
    <div
      data-slot="aui_thread-list-item"
      data-active={active || undefined}
      data-unread={unread === true ? 'true' : undefined}
      className={cn(
        'group flex min-w-0 items-center gap-0.5 border transition-colors',
        sidebarQuietRadiusClassName,
        // The selected row gets the composer's hairline over a soft fill; rows at rest have no line.
        active
          ? 'border-border bg-dropdown-selected-item-bg text-dropdown-selected-item-text'
          : 'border-transparent text-text-secondary hover:bg-ghost-button-hover hover:text-text-primary',
        className,
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={auiButtonClass({
          variant: 'ghost',
          className: cn(
            '!justify-start h-auto min-h-8 min-w-0 flex-1 overflow-hidden rounded-[1.25rem] border-0 px-2.5 py-1.5 text-left font-normal shadow-none',
            'bg-transparent hover:bg-transparent hover:text-inherit',
            active ? 'text-dropdown-selected-item-text' : 'text-inherit',
          ),
        })}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'block truncate text-sm text-text-primary',
                unread === true ? 'font-semibold' : 'font-normal',
              )}
            >
              {title}
            </span>
            {unread === true ? (
              <span
                role="img"
                aria-label="New reminder"
                data-slot="aui_thread-list-item-unread"
                className="bg-primary-button-bg size-2 shrink-0 rounded-full"
              />
            ) : null}
          </span>
          {agentName != null ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[0.75rem] text-text-secondary">
              <Icon name="bot" className="shrink-0" />
              <span className="truncate">{agentName}</span>
            </span>
          ) : null}
        </span>
      </button>
      {hasTrailing ? (
        <div className="relative mr-1 flex size-7 shrink-0 items-center justify-center">
          {relative != null ? (
            <span
              data-slot="aui_thread-list-item-age"
              className={cn(
                'pointer-events-none text-xs text-text-secondary transition-opacity',
                // md: variants survive host Tailwind tree-shaking (same set as AgentsLibrary).
                // Bare group-hover:opacity-* is dropped from the example CSS bundle.
                actions != null &&
                  'opacity-0 md:opacity-100 md:group-hover:opacity-0 md:group-focus-within:opacity-0 md:group-has-[[data-state=open]]:opacity-0',
              )}
            >
              {relative}
            </span>
          ) : null}
          {actions != null ? (
            <div
              data-slot="aui_thread-list-item-actions"
              className={cn(
                'absolute inset-0 flex items-center justify-center transition-opacity',
                relative != null &&
                  'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:group-has-[[data-state=open]]:opacity-100',
              )}
            >
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ThreadListRow: typeof ThreadListRow;
  }
}
