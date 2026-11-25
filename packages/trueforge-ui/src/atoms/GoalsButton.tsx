'use client';

import { useOptionalGoals } from '../goals/GoalsContext.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import {
  auiButtonClass,
  railSelectedClassName,
  sidebarButtonRadiusClassName,
  sidebarRailButtonClassName,
} from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type GoalsButtonProps = {
  className?: string;
  compact?: boolean;
  /** Whether this is the current screen. The rail decides this in one place; on its own the button follows its page. */
  selected?: boolean;
};

/** Sidebar entry for Goals, in the main navigation. Shown only where the host serves goals. */
export function GoalsButton({ className, compact = false, selected }: GoalsButtonProps) {
  const shell = useOptionalShellMode();
  const goals = useOptionalGoals();

  const enabled = goals !== null && shell != null;
  const open = shell?.goalsOpen === true;
  const highlighted = selected ?? open;

  if (!enabled) return null;

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <button
        type="button"
        aria-label={compact ? 'Goals' : undefined}
        title={compact ? 'Goals' : undefined}
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
        onClick={() => (open ? shell.closeGoals() : shell.openGoals())}
      >
        <Icon name="target" size={compact ? 14 : undefined} />
        {compact ? (
          <span className="text-center">Goals</span>
        ) : (
          <>
            <span className="truncate">Goals</span>
            <Icon name="chevron-right" className="ml-auto size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    GoalsButton: typeof GoalsButton;
  }
}
