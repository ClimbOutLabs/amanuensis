'use client';

import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useOptionalSpaces } from '../server/SpaceContext.js';
import {
  auiButtonClass,
  railSelectedClassName,
  sidebarButtonRadiusClassName,
  sidebarRailButtonClassName,
} from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type SpacesButtonProps = {
  className?: string;
  compact?: boolean;
  /** Whether this is the current screen. The rail decides this in one place; on its own the button follows its page. */
  selected?: boolean;
};

/**
 * Sidebar entry: navigates to the full-page Spaces view (list, or the space last open there).
 *
 * `SpacesButton` is a public export, so a host can mount it outside `TrueForgeUIShell`, which is
 * the only place that pairs `SpaceProvider` with `ShellModeProvider`. Navigation goes through
 * `useShellMode().openSpaces()`, so without that provider a click would otherwise do nothing with
 * no visible cause. Render disabled with an explanatory title instead of a silently dead button.
 */
export function SpacesButton({ className, compact = false, selected }: SpacesButtonProps) {
  const spaces = useOptionalSpaces();
  const shell = useOptionalShellMode();

  if (spaces === null) return null;

  const shellAvailable = shell !== null;
  const open = shell?.spacesOpen === true;
  const highlighted = selected ?? open;
  const title = !shellAvailable
    ? 'Spaces requires TrueForgeUIShell (no ShellModeProvider found)'
    : compact
      ? 'Spaces'
      : undefined;

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <button
        type="button"
        disabled={!shellAvailable}
        aria-label={compact ? 'Spaces' : undefined}
        title={title}
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
        onClick={() => shell?.openSpaces()}
      >
        <Icon name="cube" size={compact ? 14 : undefined} />
        {compact ? (
          <span className="text-center">Spaces</span>
        ) : (
          <>
            <span className="truncate">
              Spaces
              {spaces.spaces.length > 0 ? <span className="text-text-secondary"> ({spaces.spaces.length})</span> : null}
            </span>
            <Icon name="chevron-right" className="ml-auto size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    SpacesButton: typeof SpacesButton;
  }
}
