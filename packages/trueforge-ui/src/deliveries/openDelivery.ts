import type { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { DeliveryLink } from './types.js';

type Shell = NonNullable<ReturnType<typeof useOptionalShellMode>>;

/** Opens what an item leads to: its chat, or its space. An approval opens the chat that holds the card. */
export function openDeliveryLink({ shell, link }: { shell: Shell; link: DeliveryLink }): void {
  shell.setSettingsOpen(false);
  shell.setLibraryOpen(false);
  shell.setSessionsOpen(false);
  shell.setSchedulesOpen(false);
  if (link.type === 'space') {
    shell.openSpaces(link.spaceId);
    return;
  }
  shell.closeSpaces();
  shell.openHistorySession({ sessionId: link.sessionId, isMutable: false });
}
