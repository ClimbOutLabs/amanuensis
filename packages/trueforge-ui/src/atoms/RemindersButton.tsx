'use client';

import { Icon } from '../icons/Icon.js';
import { useOptionalReminderList } from '../reminders/ReminderListContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import {
  auiButtonClass,
  railSelectedClassName,
  sidebarButtonRadiusClassName,
  sidebarRailButtonClassName,
} from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type RemindersButtonProps = {
  className?: string;
  compact?: boolean;
  /** Whether this is the current screen. The rail decides this in one place; on its own the button follows its page. */
  selected?: boolean;
};

export function RemindersButton({ className, compact = false, selected }: RemindersButtonProps) {
  const shell = useOptionalShellMode();
  const reminders = useOptionalReminderList();

  const enabled = reminders !== null && shell != null;
  const open = shell?.remindersOpen === true;
  const highlighted = selected ?? open;

  if (!enabled) return null;

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <button
        type="button"
        aria-label={compact ? 'Reminders' : undefined}
        title={compact ? 'Reminders' : undefined}
        aria-current={highlighted ? 'page' : undefined}
        className={auiButtonClass({
          variant: 'ghost',
          className: cn(
            sidebarButtonRadiusClassName,
            'font-normal text-sidebar-text shadow-none hover:bg-secondary-button-hover hover:text-ghost-button-text',
            compact ? sidebarRailButtonClassName : 'h-8 w-full !justify-start px-2.5 text-sm',
            highlighted &&
              (compact
                ? railSelectedClassName
                : 'bg-primary-button-bg font-medium text-primary-button-text hover:bg-primary-button-hover hover:text-primary-button-text'),
          ),
        })}
        onClick={() => shell.setRemindersOpen(!open)}
      >
        <Icon name="bell" size={compact ? 14 : undefined} />
        {compact ? (
          <span className="text-center">Reminders</span>
        ) : (
          <>
            <span className="truncate">Reminders</span>
            <Icon name="chevron-right" className="ml-auto size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    RemindersButton: typeof RemindersButton;
  }
}
