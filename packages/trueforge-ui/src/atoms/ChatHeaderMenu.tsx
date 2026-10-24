'use client';

import { useChatChromeActionsVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { headerActionClassName } from './lib/buttonClasses.js';
import { DropdownMenu } from './primitives/DropdownMenu.js';

/** The chat header's three-dots menu, for the chat's rarely used actions. Same visibility rule as they have. */
export function ChatHeaderMenu() {
  const shell = useOptionalShellMode();
  const visible = useChatChromeActionsVisible();
  const ClearChatButton = useSlot('ClearChatButton');

  if (!visible || shell == null) return null;

  return (
    <DropdownMenu
      align="end"
      className="min-w-44 rounded-[1.25rem] border border-border bg-card-bg p-1"
      trigger={
        <button type="button" aria-label="Chat actions" title="Chat actions" className={headerActionClassName}>
          <Icon name="ellipsis" size={14} />
        </button>
      }
    >
      <ClearChatButton />
    </DropdownMenu>
  );
}
