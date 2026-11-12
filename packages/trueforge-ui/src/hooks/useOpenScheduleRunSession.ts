'use client';

import { useCallback } from 'react';

import { useOptionalAgentSessionsServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { AgentSessionsServer, SessionListEntry } from '../server/types.js';

type RunSessionLookup = {
  findScheduleRunSession: (params: { scheduleId: string; runId: string }) => Promise<SessionListEntry | null>;
};

/** Narrows to a sessions server that can find the chat a schedule run writes into. */
function canFindRunSession(server: AgentSessionsServer): server is AgentSessionsServer & RunSessionLookup {
  return 'findScheduleRunSession' in server;
}

/**
 * Opens the chat a just-started schedule run writes into, so a person lands on the run instead of
 * hunting for it in the Chats list. Resolves to false when the chat cannot be found or opened here.
 */
export function useOpenScheduleRunSession(): (params: { scheduleId: string; runId: string }) => Promise<boolean> {
  const sessionsServer = useOptionalAgentSessionsServer();
  const shell = useOptionalShellMode();
  return useCallback(
    async ({ scheduleId, runId }) => {
      if (shell === null || sessionsServer === null || !canFindRunSession(sessionsServer)) return false;
      const session = await sessionsServer.findScheduleRunSession({ scheduleId, runId });
      if (session === null) return false;
      shell.openHistorySession({
        sessionId: session.id,
        ...(session.agentName == null ? {} : { agentName: session.agentName }),
      });
      return true;
    },
    [sessionsServer, shell],
  );
}
