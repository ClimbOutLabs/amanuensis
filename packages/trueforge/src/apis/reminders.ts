/**
 * Reminders API (mounted at /api/v1/user/reminders).
 *
 * Read-only: the reminders a person set, read from their schedules, for the Reminders view.
 * Making and changing reminders stays in chat. The view deletes one through the schedule it is stored as.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { InvalidPageTokenError, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';

import type { ResolveRequestContext } from '../auth/identity';
import type { IAgentStore } from '../db/agentStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore, ScheduleRecord, ScheduleRunRecord } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { listRemindersRoute } from '../routes/reminderRoutes';
import { scheduleRunsAs } from '../runtime/chatAssistant';
import { describeManifestTiming } from '../runtime/scheduleCapability';
import type { ReminderItem, ReminderState } from '../schemas/reminders';

export interface RemindersRouterDeps<TTransaction> {
  scheduleStore: Pick<IScheduleStore<TTransaction>, 'listSchedules' | 'listLatestRuns'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getOwnedIds'>;
  agentStore: Pick<IAgentStore<TTransaction>, 'getAgent'>;
  personaStore: Pick<IPersonaStore<TTransaction>, 'getPersona'>;
  personalizationStore: Pick<IPersonalizationStore<TTransaction>, 'getProfile'>;
  resolveRequestContext: ResolveRequestContext;
}

/** Runs read per reminder: the queued one, if any, and enough past ones to find the latest reminded. */
const RUNS_READ = 5;

/** One reminder as the view shows it: its words, where it stands, when it is due or last fired, and its chat. */
function reminderItem(input: {
  record: ScheduleRecord;
  runs: readonly ScheduleRunRecord[];
  personaName: string;
  sessionId: string | null;
}): ReminderItem {
  const { record, runs } = input;
  // Runs come newest due first. The queued one is not a past firing.
  const pending = runs.find(run => run.status === 'scheduled');
  const past = runs.filter(run => run.status === 'triggered' || run.status === 'failed');
  const latestPast = past[0];
  const latestReminded = past.find(run => run.status === 'triggered');

  let state: ReminderState;
  let next_due_at: string | null = null;
  if (record.status === 'paused') {
    state = 'paused';
  } else if (pending !== undefined) {
    state = 'upcoming';
    next_due_at = pending.scheduled_for;
  } else if (latestPast?.status === 'triggered') {
    state = 'reminded';
  } else if (latestPast?.status === 'failed') {
    state = 'missed';
  } else {
    // Active with nothing queued and nothing past: a one-time reminder keeps its set time.
    state = 'upcoming';
    next_due_at = record.manifest.run_at;
  }

  return {
    id: record.id,
    what: record.manifest.task,
    timezone: record.manifest.timezone,
    repeats: record.manifest.cron !== null,
    timing: describeManifestTiming(record.manifest),
    state,
    next_due_at,
    last_reminded_at:
      latestReminded === undefined ? null : (latestReminded.triggered_at ?? latestReminded.scheduled_for),
    last_due_at: latestPast?.scheduled_for ?? null,
    set_at: record.created_at,
    persona_name: input.personaName,
    session_id: input.sessionId,
  };
}

/**
 * One page of the reminders the person set. Each page reads one page of their schedules, the runs of
 * its reminders in one query, and which of their chats are still theirs in one query, so a person with
 * many reminders never fans out into a query per reminder.
 */
export async function buildRemindersPage<TTransaction>(input: {
  deps: RemindersRouterDeps<TTransaction>;
  tenant_id: string;
  owner_subject_id: string;
  limit: number;
  page_token: string | undefined;
}): Promise<{ data: ReminderItem[]; next_page_token: string | undefined }> {
  const { deps, tenant_id, owner_subject_id } = input;
  const page = await deps.scheduleStore.listSchedules({
    tenant_id,
    limit: input.limit,
    page_token: input.page_token,
    agent_names: undefined,
    created_by_or_agent_ids: { created_by_subject_id: owner_subject_id, agent_ids: [] },
  });
  const records = page.data.filter(record => record.manifest.kind === 'reminder');

  const runs = await deps.scheduleStore.listLatestRuns({
    tenant_id,
    schedule_ids: records.map(record => record.id),
    per_schedule: RUNS_READ,
  });
  const runsBySchedule = new Map<string, ScheduleRunRecord[]>();
  for (const run of runs) {
    const list = runsBySchedule.get(run.schedule_id) ?? [];
    list.push(run);
    runsBySchedule.set(run.schedule_id, list);
  }

  // A row leads only to a chat the person still has: a deleted chat, or one someone else started, gets no link.
  const originIds = [
    ...new Set(
      records.flatMap(record =>
        record.manifest.origin_session_id === null ? [] : [record.manifest.origin_session_id],
      ),
    ),
  ];
  const ownedChats = new Set(
    await deps.sessionStore.getOwnedIds({ tenant_id, ids: originIds, subject_id: owner_subject_id }),
  );

  // One persona lookup per persona or agent, not per reminder: the helper keeps what it has read.
  const runsAs = scheduleRunsAs({
    tenant_id,
    agentStore: deps.agentStore,
    personaStore: deps.personaStore,
    personalizationStore: deps.personalizationStore,
  });
  const data: ReminderItem[] = [];
  for (const record of records) {
    const origin = record.manifest.origin_session_id;
    data.push(
      reminderItem({
        record,
        runs: runsBySchedule.get(record.id) ?? [],
        personaName: await runsAs(record),
        sessionId: origin !== null && ownedChats.has(origin) ? origin : null,
      }),
    );
  }
  return { data, next_page_token: page.pagination.next_page_token };
}

/** The signed-in person's reminders, mounted at /api/v1/user/reminders. Every read is scoped to tenant and creator. */
export function createRemindersRouter<TTransaction>(deps: RemindersRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listRemindersRoute> = async c => {
    const context = deps.resolveRequestContext(c);
    const query = c.req.valid('query');
    try {
      const page = await buildRemindersPage({
        deps,
        tenant_id: context.tenant_id,
        owner_subject_id: context.subject.id,
        limit: query.limit,
        page_token: query.page_token,
      });
      return c.json(page, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json(
          { error: { message: 'That page of your reminders is out of date. Reload to start again.' } },
          400,
        );
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(listRemindersRoute, listHandler);
  return router;
}
