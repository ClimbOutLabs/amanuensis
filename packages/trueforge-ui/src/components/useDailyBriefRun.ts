'use client';

import { isMorningBriefSchedule } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToasterOptional } from '../containers/ToasterContainer.js';
import { useOpenScheduleRunSession } from '../hooks/useOpenScheduleRunSession.js';
import { useResourcePermissions } from '../hooks/useResourcePermissions.js';
import { useOptionalScheduleServer } from '../server/ServerContext.js';
import type { Schedule, ScheduleServer } from '../server/types.js';

/** How many schedule pages the home reads looking for the brief; a person has a handful of schedules. */
const MAX_SCHEDULE_PAGES = 4;

/** Every brief schedule in the first pages, in list order, so the pick can weigh status and permission. */
async function findBriefSchedules(server: ScheduleServer): Promise<Schedule[]> {
  const found: Schedule[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_SCHEDULE_PAGES; page++) {
    const { data, nextPageToken } = await server.listSchedules(pageToken === undefined ? undefined : { pageToken });
    found.push(...data.filter(isMorningBriefSchedule));
    if (nextPageToken === undefined) break;
    pageToken = nextPageToken;
  }
  return found;
}

export type DailyBriefRun = {
  /** Starts a run; does nothing while one is already starting. */
  run: () => void;
  /** True from the tap until the run is started and its chat opened, or the start fails. */
  starting: boolean;
};

/**
 * Runs the person's daily brief schedule now, as Schedules > Run now does, then opens the chat the run
 * writes into. Only a schedule the person may manage counts, as on the Schedules page, and an active one
 * wins over a paused one. Undefined while there is no such schedule, so the home leaves the card out.
 */
export function useDailyBriefRun(): DailyBriefRun | undefined {
  const scheduleServer = useOptionalScheduleServer();
  const openRunSession = useOpenScheduleRunSession();
  const toaster = useToasterOptional();
  const [candidates, setCandidates] = useState<Schedule[]>([]);
  const [starting, setStarting] = useState(false);
  // The flag the click handler reads; state alone lags a render, which lets two fast taps both start.
  const inFlight = useRef(false);
  const { allows } = useResourcePermissions({
    resourceType: 'schedule',
    resourceIds: candidates.map(schedule => schedule.id),
  });

  useEffect(() => {
    if (scheduleServer === null) return;
    let cancelled = false;
    // A failed read only hides the card; the home has nothing to say about it.
    findBriefSchedules(scheduleServer)
      .then(found => {
        if (!cancelled) setCandidates(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scheduleServer]);

  const brief = useMemo(() => {
    const manageable = candidates.filter(schedule => allows(schedule.id, 'MANAGE'));
    return manageable.find(schedule => schedule.status === 'active') ?? manageable[0] ?? null;
  }, [allows, candidates]);

  const run = useCallback(
    async ({ server, schedule }: { server: ScheduleServer; schedule: Schedule }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStarting(true);
      try {
        const started = await server.createScheduleRun({ scheduleId: schedule.id });
        toaster?.showSuccess({ title: 'Run started' });
        await openRunSession({ scheduleId: schedule.id, runId: started.id });
      } catch (caught) {
        toaster?.showError(caught);
      } finally {
        inFlight.current = false;
        setStarting(false);
      }
    },
    [openRunSession, toaster],
  );

  if (scheduleServer === null || brief === null) return undefined;
  return { run: () => void run({ server: scheduleServer, schedule: brief }), starting };
}
