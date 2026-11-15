import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { GoogleConnectionStore } from '@truefoundry/trueforge-core/core/google/connection';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { getTodayRoute } from '../routes/todayRoutes';
import { endOfLocalDay, readTodayCalendar, type TodayCalendarDeps } from '../runtime/todayCalendar';
import { listWaitingNeedsOk } from '../runtime/todayNeedsOk';
import type { Today, TodayDueReminder } from '../schemas/today';

export interface TodayRouterDeps {
  googleConnectionStore: GoogleConnectionStore | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'getServer'>;
  scheduleStore: Pick<IScheduleStore, 'listSchedules' | 'getScheduledRunsFor' | 'getSchedule'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions' | 'getSessionByExternalId'>;
  sessions: Pick<Sessions<SessionCustom, TurnCustom>, 'get'>;
  calendarAccountUrl: string | undefined;
  calendarAccountKey: string | undefined;
  fetchImpl: typeof fetch | undefined;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  /** Replaceable so tests set the day; the server passes the real clock. */
  now: () => Date;
}

/** Most schedules read for the due list. */
const SCHEDULE_SCAN_LIMIT = 200;

/**
 * The reminders due today or overdue, earliest first. A reminder is due when
 * its pending run falls at or before the end of the person's local day. Once it goes off it
 * has no pending run, so it leaves this list and the bell carries it instead.
 */
async function readDue(
  deps: TodayRouterDeps,
  input: { tenant_id: string; created_by: string; timeZone: string | undefined; now: Date },
): Promise<TodayDueReminder[]> {
  const { data: schedules } = await deps.scheduleStore.listSchedules({
    tenant_id: input.tenant_id,
    limit: SCHEDULE_SCAN_LIMIT,
    page_token: undefined,
    agent_names: undefined,
    created_by_or_agent_ids: { created_by_subject_id: input.created_by, agent_ids: [] },
  });
  const active = schedules.filter(schedule => schedule.status === 'active');
  const dayEnd = endOfLocalDay({ now: input.now, timeZone: input.timeZone });
  const remindersChat = await deps.sessionStore.getSessionByExternalId({
    tenant_id: input.tenant_id,
    external_id: `reminders:${input.created_by}`,
  });
  // One lookup for every reminder's pending run, not one per schedule.
  const reminderIds = active.filter(schedule => schedule.manifest.kind === 'reminder').map(schedule => schedule.id);
  const pendingRuns = await deps.scheduleStore.getScheduledRunsFor({
    tenant_id: input.tenant_id,
    schedule_ids: reminderIds,
  });
  const runBySchedule = new Map(pendingRuns.map(run => [run.schedule_id, run]));
  const due: TodayDueReminder[] = [];
  for (const schedule of active) {
    if (schedule.manifest.kind !== 'reminder') {
      continue;
    }
    const run = runBySchedule.get(schedule.id);
    if (run === undefined || Date.parse(run.scheduled_for) > dayEnd.getTime()) {
      continue;
    }
    due.push({
      reminder_id: schedule.id,
      title: schedule.manifest.task,
      due_at: run.scheduled_for,
      session_id: remindersChat?.session_id ?? null,
    });
  }
  due.sort((left, right) => left.due_at.localeCompare(right.due_at));
  return due;
}

/**
 * The right rail's Home view (mounted at /api/v1/today). Every part is read from stored state:
 * the calendar connectors, the schedule store, and the chats' own approval records. No code
 * path from here reaches the model runtime or the email connector.
 */
export function createTodayRouter(deps: TodayRouterDeps) {
  const router = new OpenAPIHono();

  const getHandler: RouteHandler<typeof getTodayRoute> = async c => {
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const owner = { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
    const now = deps.now();
    const calendarDeps: TodayCalendarDeps = {
      googleConnectionStore: deps.googleConnectionStore,
      mcpServerStore: deps.mcpServerStore,
      tenant_id: owner.tenant_id,
      calendarAccountUrl: deps.calendarAccountUrl,
      calendarAccountKey: deps.calendarAccountKey,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
      now: deps.now,
    };
    const [calendar, due, needsOk] = await Promise.all([
      readTodayCalendar(calendarDeps, { owner, timeZone: query.client_timezone }),
      readDue(deps, { ...owner, timeZone: query.client_timezone, now }),
      listWaitingNeedsOk(
        {
          sessions: deps.sessions,
          sessionStore: deps.sessionStore,
          scheduleStore: deps.scheduleStore,
          logger: deps.logger,
        },
        { ...owner, now },
      ),
    ]);
    const data: Today = {
      calendar: calendar.calendar,
      free_after: calendar.free_after,
      due,
      needs_ok: needsOk.items,
      needs_ok_more: needsOk.more,
      as_of: now.toISOString(),
    };
    return c.json({ data }, 200);
  };

  router.openapi(getTodayRoute, getHandler);
  return router;
}
