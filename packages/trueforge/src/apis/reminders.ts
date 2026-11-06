/**
 * Reminders API (mounted at /api/v1/user/reminders).
 *
 * Read-only: the reminders a person set, read from their schedules, for the Reminders view.
 * Making, changing and cancelling reminders stays in chat, where it already lives.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { REMINDERS_CHAT_TITLE } from '@truefoundry/trueforge-core/core/schedules/toolContract';

import type { ResolveRequestContext } from '../auth/identity';
import type { IAgentStore } from '../db/agentStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore, ScheduleRecord } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { listRemindersRoute } from '../routes/reminderRoutes';
import { scheduleRunsAs } from '../runtime/chatAssistant';
import { describeManifestTiming } from '../runtime/scheduleCapability';
import type { ReminderItem, ReminderState } from '../schemas/reminders';

export interface RemindersRouterDeps<TTransaction> {
  scheduleStore: Pick<IScheduleStore<TTransaction>, 'listSchedules' | 'listRuns' | 'getScheduledRunFor'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSessionByExternalId'>;
  agentStore: Pick<IAgentStore<TTransaction>, 'getAgent'>;
  personaStore: Pick<IPersonaStore<TTransaction>, 'getPersona'>;
  personalizationStore: Pick<IPersonalizationStore<TTransaction>, 'getProfile'>;
  resolveRequestContext: ResolveRequestContext;
}

const REMINDERS_PAGE_SIZE = 100;
/** Same bound the chat tools use when they read a person's reminders. */
const REMINDERS_LOOKUP_LIMIT = 500;
/** Past runs read per reminder; the view shows only the latest, with room to find it past the queued one. */
const RUNS_READ = 5;

/** The external id of the one chat reminders are delivered into. Mirrors the writer in reminderDelivery. */
function remindersExternalId(subjectId: string): string {
  return `reminders:${subjectId}`;
}

/** One reminder as the view shows it: its words, where it stands, and when it is due or last fired. */
async function reminderItem<TTransaction>(input: {
  deps: RemindersRouterDeps<TTransaction>;
  record: ScheduleRecord;
  runsAs: (schedule: ScheduleRecord) => Promise<string>;
}): Promise<ReminderItem> {
  const { deps, record } = input;
  const pending = await deps.scheduleStore.getScheduledRunFor({
    tenant_id: record.tenant_id,
    schedule_id: record.id,
  });
  const { data: runs } = await deps.scheduleStore.listRuns({
    tenant_id: record.tenant_id,
    schedule_id: record.id,
    limit: RUNS_READ,
    page_token: undefined,
  });
  // Runs come back newest due first; the queued one is not a past firing.
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
    persona_name: await input.runsAs(record),
  };
}

/**
 * Every reminder the person set, plus the chat they are delivered into. The chat is read, never
 * made: it exists only once a first reminder has fired, and until then the view says so.
 */
export async function buildRemindersView<TTransaction>(input: {
  deps: RemindersRouterDeps<TTransaction>;
  tenant_id: string;
  owner_subject_id: string;
}): Promise<{ data: ReminderItem[]; reminders_chat: { session_id: string; title: string } | null }> {
  const { deps, tenant_id, owner_subject_id } = input;
  const records: ScheduleRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await deps.scheduleStore.listSchedules({
      tenant_id,
      limit: REMINDERS_PAGE_SIZE,
      page_token: pageToken,
      agent_names: undefined,
      created_by_or_agent_ids: { created_by_subject_id: owner_subject_id, agent_ids: [] },
    });
    records.push(...page.data.filter(record => record.manifest.kind === 'reminder'));
    pageToken = page.pagination.next_page_token;
  } while (pageToken !== undefined && records.length < REMINDERS_LOOKUP_LIMIT);

  const runsAs = scheduleRunsAs({
    tenant_id,
    agentStore: deps.agentStore,
    personaStore: deps.personaStore,
    personalizationStore: deps.personalizationStore,
  });
  const data = await Promise.all(records.map(record => reminderItem({ deps, record, runsAs })));

  const chat = await deps.sessionStore.getSessionByExternalId({
    tenant_id,
    external_id: remindersExternalId(owner_subject_id),
  });
  return {
    data,
    reminders_chat:
      chat === undefined ? null : { session_id: chat.session_id, title: chat.title ?? REMINDERS_CHAT_TITLE },
  };
}

/** The signed-in person's reminders, mounted at /api/v1/user/reminders. Every read is scoped to tenant and creator. */
export function createRemindersRouter<TTransaction>(deps: RemindersRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listRemindersRoute> = async c => {
    const context = deps.resolveRequestContext(c);
    const view = await buildRemindersView({
      deps,
      tenant_id: context.tenant_id,
      owner_subject_id: context.subject.id,
    });
    return c.json(view, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listRemindersRoute, listHandler);
  return router;
}
