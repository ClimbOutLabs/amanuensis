import { sessionIsCreateAgent } from '../atoms/lib/sessionCreateAgent.js';
import type { useOptionalServer } from '../server/ServerContext.js';
import type { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { DeliveryLink } from './types.js';

type Shell = NonNullable<ReturnType<typeof useOptionalShellMode>>;
type Server = ReturnType<typeof useOptionalServer>;

/**
 * Opens what an item leads to: its space, or the chat it names. An approval opens the chat that
 * holds the card. The chat is looked up first, the way opening a chat by id works, so it opens
 * with its own mutability and agent instead of a guess. A chat that cannot be loaded, for
 * example because it was deleted, opens nothing, and no raw error is shown.
 */
export async function openDeliveryLink({
  shell,
  server,
  link,
}: {
  shell: Shell;
  server: Server;
  link: DeliveryLink;
}): Promise<void> {
  if (link.type === 'space') {
    shell.setSettingsOpen(false);
    shell.setLibraryOpen(false);
    shell.setSessionsOpen(false);
    shell.setSchedulesOpen(false);
    shell.openSpaces(link.spaceId);
    return;
  }
  if (server === null) return;
  const session = await server.getSession({ sessionId: link.sessionId }).catch(() => null);
  if (session === null) return;
  shell.setSettingsOpen(false);
  shell.setLibraryOpen(false);
  shell.setSessionsOpen(false);
  shell.setSchedulesOpen(false);
  shell.closeSpaces();
  shell.openHistorySession({
    sessionId: link.sessionId,
    isMutable: session.isMutable,
    isCreateAgent: sessionIsCreateAgent(session),
    ...(session.agentName != null ? { agentName: session.agentName } : {}),
  });
}
