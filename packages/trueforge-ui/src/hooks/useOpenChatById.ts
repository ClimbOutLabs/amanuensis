'use client';

import { useCallback, useRef } from 'react';

import { sessionIsCreateAgent } from '../atoms/lib/sessionCreateAgent.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';

/**
 * Opens a chat known only by its id. The server is asked whether the id names a mutable draft
 * or an agent chat, since guessing "mutable" opens an agent session as a blank draft. A reply
 * that a later open superseded is dropped, and an unreachable chat is opened by id alone.
 * Outside a shell there is nowhere to open a chat, so the call does nothing.
 */
export function useOpenChatById(): (sessionId: string) => void {
  const shell = useOptionalShellMode();
  const server = useOptionalServer();
  const requestedSessionRef = useRef<string | null>(null);
  return useCallback(
    (sessionId: string) => {
      if (shell === null) return;
      requestedSessionRef.current = sessionId;
      if (server == null) {
        shell.openHistorySession({ sessionId });
        return;
      }
      void server
        .getSession({ sessionId })
        .then(session => {
          if (requestedSessionRef.current !== sessionId) return;
          shell.openHistorySession({
            sessionId,
            isMutable: session.isMutable,
            isCreateAgent: sessionIsCreateAgent(session),
            ...(session.agentName != null ? { agentName: session.agentName } : {}),
          });
        })
        .catch(() => {
          if (requestedSessionRef.current !== sessionId) return;
          shell.openHistorySession({ sessionId });
        });
    },
    [server, shell],
  );
}
