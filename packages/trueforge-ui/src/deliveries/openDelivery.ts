import { sessionIsCreateAgent } from '../atoms/lib/sessionCreateAgent.js';
import type { useOptionalServer } from '../server/ServerContext.js';
import type { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { DeliveryLink } from './types.js';

type Shell = NonNullable<ReturnType<typeof useOptionalShellMode>>;
type Server = ReturnType<typeof useOptionalServer>;

/** How opening what an item leads to ended: it opened, or it stayed shut and this is why, in plain words. */
export type OpenDeliveryOutcome = { opened: true } | { opened: false; message: string };

const CHAT_DELETED_MESSAGE = 'This chat was deleted';
const OPEN_FAILED_MESSAGE = 'Could not open the chat. Try again';

/** A chat that is gone answers 404, which the server client surfaces as a NotFoundError. */
function isChatGoneError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? error.name : undefined;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  return name === 'NotFoundError' || statusCode === 404;
}

/**
 * Opens what an item leads to: its space, or the chat it names. An approval opens the chat that
 * holds the card. The chat is looked up first, the way opening a chat by id works, so it opens
 * with its own mutability and agent instead of a guess. When the chat cannot be opened, nothing
 * opens and the outcome says why, in plain words, so the caller can show it.
 */
export async function openDeliveryLink({
  shell,
  server,
  link,
}: {
  shell: Shell;
  server: Server;
  link: DeliveryLink;
}): Promise<OpenDeliveryOutcome> {
  if (link.type === 'space') {
    shell.setSettingsOpen(false);
    shell.setLibraryOpen(false);
    shell.setSessionsOpen(false);
    shell.setSchedulesOpen(false);
    shell.setRemindersOpen(false);
    shell.openSpaces(link.spaceId);
    return { opened: true };
  }
  if (server === null) return { opened: false, message: OPEN_FAILED_MESSAGE };
  try {
    const session = await server.getSession({ sessionId: link.sessionId });
    shell.setSettingsOpen(false);
    shell.setLibraryOpen(false);
    shell.setSessionsOpen(false);
    shell.setSchedulesOpen(false);
    shell.setRemindersOpen(false);
    shell.closeSpaces();
    shell.openHistorySession({
      sessionId: link.sessionId,
      isMutable: session.isMutable,
      isCreateAgent: sessionIsCreateAgent(session),
      ...(session.agentName != null ? { agentName: session.agentName } : {}),
    });
    return { opened: true };
  } catch (error) {
    return { opened: false, message: isChatGoneError(error) ? CHAT_DELETED_MESSAGE : OPEN_FAILED_MESSAGE };
  }
}
