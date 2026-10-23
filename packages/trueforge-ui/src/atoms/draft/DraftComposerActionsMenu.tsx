'use client';

import { Icon } from '../../icons/Icon.js';
import { DropdownMenu, DropdownMenuItem } from '../primitives/DropdownMenu.js';

export type DraftComposerAction = {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Plain hover text for the item, such as a summary of what is selected. */
  title?: string;
};

export type DraftComposerActionsMenuProps = {
  actions: DraftComposerAction[];
  disabled?: boolean;
  /** Small count on the trigger; hidden at zero so it never reads "0". */
  badgeCount?: number;
};

export function DraftComposerActionsMenu({ actions, disabled, badgeCount = 0 }: DraftComposerActionsMenuProps) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      align="start"
      side="top"
      className="w-56"
      trigger={
        <button
          type="button"
          aria-label="Add"
          title="Add"
          disabled={disabled}
          className="bg-ghost-button-bg text-ghost-button-text hover:bg-ghost-button-hover focus-visible:ring-focus-ring relative inline-flex size-11 shrink-0 sm:size-8 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="plus" className="size-4" />
          {badgeCount > 0 ? (
            <span
              data-slot="aui_composer-plus-badge"
              className="bg-primary-button-bg text-primary-button-text absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] leading-none font-semibold"
            >
              {badgeCount}
            </span>
          ) : null}
        </button>
      }
    >
      {actions.map(action => (
        <DropdownMenuItem key={action.id} disabled={action.disabled} title={action.title} onClick={action.onSelect}>
          <Icon name={action.icon} className="text-text-secondary size-4 shrink-0" />
          <span>{action.label}</span>
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    DraftComposerActionsMenu: typeof DraftComposerActionsMenu;
  }
}
