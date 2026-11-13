'use client';

import { Icon } from '../icons/Icon.js';
import { useOptionalCatalogServer, useServerCapabilities } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { isSettingsChromeEnabled } from '../server/serverChrome.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { AppearanceChoices, AppearanceMenuButton } from './AppearanceChoices.js';
import { BugReportButton } from './BugReportButton.js';
import { auiButtonClass, railMenuRowClassName, sidebarRailButtonClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export function ShellActions({
  className,
  labeled = false,
  rows = false,
}: {
  className?: string;
  labeled?: boolean;
  /** Lays the labeled actions out as menu rows instead of rail tiles. */
  rows?: boolean;
}) {
  const shell = useOptionalShellMode();
  const catalog = useOptionalCatalogServer();
  const capabilities = useServerCapabilities();
  const ActionSlot = useSlot('ShellActionsActionSlot');
  const SessionsBrowserButton = useSlot('SessionsBrowserButton');
  const settingsChromeEnabled = isSettingsChromeEnabled({ catalog, capabilities });

  const hoverClass = 'hover:bg-secondary-button-hover hover:text-ghost-button-text';

  // Footer order (top to bottom): Appearance, Settings, Sessions, Bugs, host slot (e.g. Logout).
  // Sessions renders only in the labeled rail: the unlabeled header row never had it, and the
  // rail button styling does not fit an icon row.
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1',
        labeled ? 'w-full flex-col items-center gap-1 text-sidebar-text' : 'text-text-primary',
        className,
      )}
    >
      {rows ? <AppearanceChoices /> : <AppearanceMenuButton className={hoverClass} />}
      {shell != null && settingsChromeEnabled ? (
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          aria-expanded={shell.settingsOpen}
          aria-current={shell.settingsOpen ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            size: labeled ? undefined : 'icon',
            className: cn(
              hoverClass,
              labeled && (rows ? railMenuRowClassName : sidebarRailButtonClassName),
              shell.settingsOpen &&
                'border-border bg-dropdown-selected-item-bg text-dropdown-selected-item-text hover:text-dropdown-selected-item-text',
            ),
          })}
          onClick={() => shell.setSettingsOpen(true)}
        >
          <Icon name="settings" size={labeled ? 14 : undefined} />
          {labeled ? <span className="text-center">Settings</span> : null}
        </button>
      ) : null}
      {labeled ? <SessionsBrowserButton compact={!rows} row={rows} /> : null}
      <BugReportButton row={labeled && rows} />
      <ActionSlot row={labeled && rows} />
    </div>
  );
}
