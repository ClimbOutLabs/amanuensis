'use client';

import { Icon } from '../icons/Icon.js';
import { useOptionalScheduleServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { isSchedulesChromeEnabled } from '../server/serverChrome.js';
import {
  auiButtonClass,
  railSelectedClassName,
  sidebarButtonRadiusClassName,
  sidebarRailButtonClassName,
} from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type SchedulesButtonProps = {
  className?: string;
  compact?: boolean;
  /** Whether this is the current screen. The rail decides this in one place; on its own the button follows its page. */
  selected?: boolean;
};

export function SchedulesButton({ className, compact = false, selected }: SchedulesButtonProps) {
  const shell = useOptionalShellMode();
  const scheduleServer = useOptionalScheduleServer();

  const enabled = isSchedulesChromeEnabled({ schedules: scheduleServer }) && shell != null;
  const open = shell?.schedulesOpen === true;
  const highlighted = selected ?? open;

  if (!enabled) return null;

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <button
        type="button"
        aria-label={compact ? 'Schedules' : undefined}
        title={compact ? 'Schedules' : undefined}
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
        onClick={() => shell.setSchedulesOpen(!open)}
      >
        <Icon name="calendar-clock" size={compact ? 14 : undefined} />
        {compact ? (
          <span className="text-center">Schedules</span>
        ) : (
          <>
            <span className="truncate">Schedules</span>
            <Icon name="chevron-right" className="ml-auto size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SchedulesButton: typeof SchedulesButton;
  }
}
