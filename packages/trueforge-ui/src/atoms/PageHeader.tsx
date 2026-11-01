'use client';

import type { ReactNode } from 'react';

import { HelpStuckButton } from '../help/HelpStuckButton.js';
import { cn } from './lib/cn.js';

/** Shared title styles for page / chat chrome headers. */
export const pageHeaderTitleClassName = 'text-text-primary min-w-0 truncate text-base font-semibold';

export type PageHeaderProps = {
  /** Page name, or a custom title node (e.g. `NamedAgentHeaderLabel`). Strings use the shared h1 styles. */
  title?: ReactNode;
  /** Leading chrome (back / menu). */
  start?: ReactNode;
  /** Trailing actions; pushed to the end. */
  end?: ReactNode;
  /** Adds the "Help, I'm stuck" button after the trailing actions. Set on the main screen headers only. */
  helpAction?: boolean;
  /** A menu button placed last, after the help button. */
  menu?: ReactNode;
  /** Keeps every action on one row, truncating the title first, as the chat header does on a phone. */
  singleLine?: boolean;
  /** Extra content between title and end (prefer `start` / `end` when possible). */
  children?: ReactNode;
  className?: string;
};

/** Shared shell/page header bar used by chat chrome and list pages.
 * `min-h-14` keeps a single-row bar aligned with Agent Config; wrapping end actions can grow the bar.
 */
export function PageHeader({
  title,
  start,
  end,
  helpAction = false,
  menu,
  singleLine = false,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-4',
        singleLine ? 'flex-nowrap' : 'flex-wrap',
        className,
      )}
    >
      {start}
      {typeof title === 'string' ? <h1 className={pageHeaderTitleClassName}>{title}</h1> : title}
      {children}
      {end != null || helpAction || menu != null ? (
        <div
          className={cn('ml-auto flex items-center gap-1', singleLine ? 'shrink-0 flex-nowrap' : 'min-w-0 flex-wrap')}
        >
          {end}
          {helpAction ? <HelpStuckButton /> : null}
          {menu}
        </div>
      ) : null}
    </header>
  );
}
