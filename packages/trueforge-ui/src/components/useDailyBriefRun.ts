'use client';

import { isMorningBriefSchedule } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { useCallback, useEffect, useState } from 'react';

import { useToasterOptional } from '../containers/ToasterContainer.js';
import { useOptionalAgentSessionsServer, useOptionalScheduleServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import type { AgentSessionsServer, Schedule, ScheduleServer, SessionListEntry } from '../server/types.js';

/** How many schedule pages the home reads looking for the brief; a person has a handful of schedules. */
const MAX_SCHEDULE_PAGES = 4;

type RunSessionLookup = {
  findScheduleRunSession: (params: { scheduleId: string; runId: string }) => Promise<SessionListEntry | null>;
};

/** Narrows to a sessions server that can find the chat a schedule run writes into. */
function canFindRunSession(server: AgentSessionsServer): server is AgentSessionsServer & RunSessionLookup {
  return 'findScheduleRunSession' in server;
}

async function findBriefSchedule(server: ScheduleServer): Promise<Schedule | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_SCHEDULE_PAGES; page++) {
    const { data, nextPageToken } = await server.listSchedules(pageToken === undefined ? undefined : { pageToken });
    const brief = data.find(isMorningBriefSchedule);
    if (brief !== undefined) return brief;
    if (nextPageToken === undefined) return null;
    pageToken = nextPageToken;
  }
  return null;
}

/**
 * Runs the person's daily brief schedule now, as Schedules > Run now does, then opens the chat the run
 * writes into. Undefined while there is no brief schedule, so the home leaves the card out.
 */
export function useDailyBriefRun(): (() => void) | undefined {
  const scheduleServer = useOptionalScheduleServer();
  const sessionsServer = useOptionalAgentSessionsServer();
  const shell = useOptionalShellMode();
  const toaster = useToasterOptional();
  const [brief, setBrief] = useState<Schedule | null>(null);

  useEffect(() => {
    if (scheduleServer === null) return;
    let cancelled = false;
    // A failed read only hides the card; the home has nothing to say about it.
    findBriefSchedule(scheduleServer)
      .then(found => {
        if (!cancelled) setBrief(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scheduleServer]);

  const run = useCallback(
    async ({ server, schedule }: { server: ScheduleServer; schedule: Schedule }) => {
      try {
        const started = await server.createScheduleRun({ scheduleId: schedule.id });
        toaster?.showSuccess({ title: 'Run started' });
        if (sessionsServer === null || !canFindRunSession(sessionsServer)) return;
        const session = await sessionsServer.findScheduleRunSession({ scheduleId: schedule.id, runId: started.id });
        if (session === null) return;
        shell?.openHistorySession({
          sessionId: session.id,
          ...(session.agentName == null ? {} : { agentName: session.agentName }),
        });
      } catch (caught) {
        toaster?.showError(caught);
      }
    },
    [sessionsServer, shell, toaster],
  );

  if (scheduleServer === null || brief === null) return undefined;
  return () => void run({ server: scheduleServer, schedule: brief });
}
