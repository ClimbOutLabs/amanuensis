'use client';

import { Icon } from '../icons/Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';
import type { ThemeMode } from '../theme/types.js';
import { auiButtonClass, railMenuRowClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';
import { DropdownMenu } from './primitives/DropdownMenu.js';

/** The three appearance choices, in the order the menu lists them. */
const APPEARANCE_CHOICES: readonly { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'Match my computer' },
];

/**
 * The Appearance item with its three choices indented under it, a check on the current one. The item
 * reads like every other menu row; the theme keeps the choice.
 */
export function AppearanceChoices() {
  const { preference, setTheme } = useTheme();
  return (
    <div role="group" aria-label="Appearance" className="flex flex-col">
      <p className={cn(railMenuRowClassName, 'm-0 cursor-default hover:bg-transparent')}>
        <Icon name="palette" size={14} />
        Appearance
      </p>
      {APPEARANCE_CHOICES.map(choice => {
        const checked = preference === choice.mode;
        return (
          <button
            key={choice.mode}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            className={cn(railMenuRowClassName, 'pl-8')}
            onClick={() => setTheme(choice.mode)}
          >
            <span className="min-w-0 flex-1 text-left">{choice.label}</span>
            {checked ? <Icon name="check" size={14} className="shrink-0" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A header button that opens the Appearance choices, for layouts without the rail's More menu. */
export function AppearanceMenuButton({ className }: { className?: string }) {
  return (
    <DropdownMenu
      align="end"
      className="min-w-48 rounded-[1.25rem] border border-border bg-card-bg p-1"
      trigger={
        <button
          type="button"
          aria-label="Appearance"
          title="Appearance"
          className={auiButtonClass({ variant: 'ghost', size: 'icon', className })}
        >
          <Icon name="palette" />
        </button>
      }
    >
      <AppearanceChoices />
    </DropdownMenu>
  );
}
