import { OpenAPIHono } from '@hono/zod-openapi';
import { InMemorySessionStore } from '@truefoundry/trueforge-core/agent-session';

import { createRemindersRouter, type RemindersRouterDeps } from '../../../src/apis/reminders';
import type { RequestContext } from '../../../src/auth/identity';
import type { ScheduleRecord, ScheduleRunRecord } from '../../../src/db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import type { Persona } from '../../../src/personas/persona';
import { ListRemindersResponseSchema, type ReminderItem } from '../../../src/schemas/reminders';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};
const BOB: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'bob', type: 'user', display_name: 'bob' },
  roles: [],
  user_credential: null,
};

const OWNER = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };

const MANNIE: Persona = {
  tenant_id: 'default',
  id: 'persona-mannie',
  created_by: 'alice',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  updated_by: 'alice',
  display_name: 'Mannie',
  aliases: [],
  instructions: 'You are Mannie.',
  model_name: 'test/model',
};

let recordSeq = 0;

function reminderRecord(overrides: Partial<ScheduleRecord> & { manifest: ScheduleRecord['manifest'] }): ScheduleRecord {
  recordSeq += 1;
  return {
    id: `reminder-${String(recordSeq)}`,
    tenant_id: 'default',
    agent_id: 'agent-1',
    agent_name: 'chat-assistant-alice',
    name: `reminder-${String(recordSeq)}`,
    persona_id: 'persona-mannie',
    status: overrides.manifest.status,
    created_by_subject: OWNER,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

function manifest(input: { task: string; run_at?: string; cron?: string; status?: 'active' | 'paused' | 'done' }) {
  return ScheduleManifestSchema.parse({
    task: input.task,
    run_at: input.run_at ?? null,
    cron: input.cron ?? null,
    timezone: 'America/Los_Angeles',
    status: input.status ?? 'active',
    kind: 'reminder',
  });
}

function runRecord(overrides: Partial<ScheduleRunRecord> & { schedule_id: string }): ScheduleRunRecord {
  return {
    id: `run-${overrides.schedule_id}-${overrides.status ?? 'scheduled'}-${overrides.scheduled_for ?? ''}`,
    tenant_id: 'default',
    name: 'sched-1',
    scheduled_for: '2026-11-04T17:00:00.000Z',
    status: 'scheduled',
    created_by_subject: OWNER,
    triggered_at: null,
    reason: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

async function build(input: {
  records: ScheduleRecord[];
  /** Each reminder's runs, newest due first, the queued one included. */
  runs?: Record<string, ScheduleRunRecord[]>;
  /** Chats that exist, by id, with the person who started each. */
  chats?: Record<string, string>;
  nextPageToken?: string;
}) {
  const calls = { listSchedules: [] as { limit: number; page_token: string | undefined }[], listLatestRuns: 0 };
  const scheduleStore: RemindersRouterDeps<never>['scheduleStore'] = {
    listSchedules: async query => {
      calls.listSchedules.push({ limit: query.limit, page_token: query.page_token });
      const mine = input.records.filter(
        record =>
          record.tenant_id === query.tenant_id &&
          record.created_by_subject.subject_id === query.created_by_or_agent_ids?.created_by_subject_id,
      );
      return {
        data: mine,
        pagination:
          input.nextPageToken === undefined
            ? { limit: query.limit }
            : { limit: query.limit, next_page_token: input.nextPageToken },
      };
    },
    listLatestRuns: async query => {
      calls.listLatestRuns += 1;
      return query.schedule_ids.flatMap(id => (input.runs?.[id] ?? []).slice(0, query.per_schedule));
    },
  };
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  for (const [sessionId, subjectId] of Object.entries(input.chats ?? {})) {
    await sessionStore.createSession({
      tenant_id: 'default',
      session_id: sessionId,
      agent: { type: 'reference', id: 'agent-1', name: 'chat-assistant-alice' },
      created_by_subject: { subject_id: subjectId, subject_type: 'user', subject_display_name: subjectId },
      external_id: null,
      metadata: {},
      source: null,
      custom: null,
      is_incognito: false,
      private_expires_at: null,
    });
  }
  let current = ALICE;
  const deps: RemindersRouterDeps<never> = {
    scheduleStore,
    sessionStore,
    agentStore: { getAgent: async () => undefined },
    personaStore: {
      getPersona: async query => (query.id === MANNIE.id && query.created_by === 'alice' ? MANNIE : undefined),
    },
    personalizationStore: { getProfile: async () => undefined },
    resolveRequestContext: () => current,
  };
  const app = new OpenAPIHono();
  app.route('/reminders', createRemindersRouter(deps));
  const list = async (as: RequestContext, query = '') => {
    current = as;
    const response = await app.request(`/reminders${query}`);
    expect(response.status).toBe(200);
    return ListRemindersResponseSchema.parse(await response.json());
  };
  return { list, calls };
}

function byWhat(items: ReminderItem[], what: string): ReminderItem {
  const found = items.find(item => item.what === what);
  if (found === undefined) {
    throw new Error(`No reminder in the view says: ${what}`);
  }
  return found;
}

describe('reminders view route', () => {
  it('shows a one-time reminder that is still to come, with its due time and persona', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Take the bins out', run_at: '2026-11-04T17:00:00.000Z' }),
    });
    const { list } = await build({
      records: [record],
      runs: { [record.id]: [runRecord({ schedule_id: record.id, scheduled_for: '2026-11-04T17:00:00.000Z' })] },
    });

    const view = await list(ALICE);
    expect(view.next_page_token).toBeUndefined();
    expect(view.data).toHaveLength(1);
    const item = view.data[0];
    if (item === undefined) throw new Error('The view is empty.');
    expect(item.state).toBe('upcoming');
    expect(item.next_due_at).toBe('2026-11-04T17:00:00.000Z');
    expect(item.last_reminded_at).toBeNull();
    expect(item.persona_name).toBe('Mannie');
    expect(item.repeats).toBe(false);
    expect(item.set_at).toBe('2026-11-01T09:00:00.000Z');
  });

  it('shows a fired one-time reminder as reminded, with when it fired', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Call the dentist', run_at: '2026-11-02T17:00:00.000Z', status: 'done' }),
      status: 'done',
    });
    const { list } = await build({
      records: [record],
      runs: {
        [record.id]: [
          runRecord({
            schedule_id: record.id,
            status: 'triggered',
            scheduled_for: '2026-11-02T17:00:00.000Z',
            triggered_at: '2026-11-02T17:00:05.000Z',
          }),
        ],
      },
    });

    const view = await list(ALICE);
    const item = byWhat(view.data, 'Call the dentist');
    expect(item.state).toBe('reminded');
    expect(item.next_due_at).toBeNull();
    expect(item.last_reminded_at).toBe('2026-11-02T17:00:05.000Z');
    expect(item.last_due_at).toBe('2026-11-02T17:00:00.000Z');
  });

  it('keeps a repeating reminder upcoming after a firing, and remembers the last one', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Water the plants', cron: '0 9 * * *' }),
    });
    const { list } = await build({
      records: [record],
      runs: {
        [record.id]: [
          runRecord({ schedule_id: record.id, scheduled_for: '2026-11-04T17:00:00.000Z' }),
          runRecord({
            schedule_id: record.id,
            status: 'triggered',
            scheduled_for: '2026-11-03T17:00:00.000Z',
            triggered_at: '2026-11-03T17:00:02.000Z',
          }),
        ],
      },
    });

    const item = byWhat((await list(ALICE)).data, 'Water the plants');
    expect(item.state).toBe('upcoming');
    expect(item.repeats).toBe(true);
    expect(item.next_due_at).toBe('2026-11-04T17:00:00.000Z');
    expect(item.last_reminded_at).toBe('2026-11-03T17:00:02.000Z');
  });

  it('shows a reminder whose time came and failed as missed, not reminded', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Leave for the airport', run_at: '2026-11-02T12:00:00.000Z', status: 'done' }),
      status: 'done',
    });
    const { list } = await build({
      records: [record],
      runs: {
        [record.id]: [
          runRecord({
            schedule_id: record.id,
            status: 'failed',
            scheduled_for: '2026-11-02T12:00:00.000Z',
            reason: 'The assistant that set this reminder was deleted.',
          }),
        ],
      },
    });

    const item = byWhat((await list(ALICE)).data, 'Leave for the airport');
    expect(item.state).toBe('missed');
    expect(item.last_reminded_at).toBeNull();
    expect(item.last_due_at).toBe('2026-11-02T12:00:00.000Z');
  });

  it('shows a paused reminder as paused even though its time has not come', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Submit the form', run_at: '2026-11-05T17:00:00.000Z', status: 'paused' }),
      status: 'paused',
    });
    const { list } = await build({ records: [record] });

    const item = byWhat((await list(ALICE)).data, 'Submit the form');
    expect(item.state).toBe('paused');
    expect(item.next_due_at).toBeNull();
  });

  it('leaves out task schedules and other people their own reminders only', async () => {
    const mine = reminderRecord({ manifest: manifest({ task: 'Mine', run_at: '2026-11-04T17:00:00.000Z' }) });
    const task = reminderRecord({
      manifest: ScheduleManifestSchema.parse({
        task: 'Weekly research',
        cron: '0 8 * * 1',
        run_at: null,
        timezone: 'America/Los_Angeles',
        status: 'active',
        kind: 'task',
      }),
    });
    const bobs = reminderRecord({
      manifest: manifest({ task: 'Bob reminder', run_at: '2026-11-04T17:00:00.000Z' }),
      created_by_subject: { subject_id: 'bob', subject_type: 'user', subject_display_name: 'bob' },
    });
    const { list } = await build({ records: [mine, task, bobs] });

    const view = await list(ALICE);
    expect(view.data.map(item => item.what)).toEqual(['Mine']);
    const bobsView = await list(BOB);
    expect(bobsView.data.map(item => item.what)).toEqual(['Bob reminder']);
  });

  it('falls back to the agent name when the persona is gone', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Stretch', run_at: '2026-11-04T17:00:00.000Z' }),
      persona_id: 'persona-deleted',
    });
    const { list } = await build({
      records: [record],
      runs: { [record.id]: [runRecord({ schedule_id: record.id })] },
    });

    const item = byWhat((await list(ALICE)).data, 'Stretch');
    expect(item.persona_name).toBe('chat-assistant-alice');
  });

  it('links each reminder to the chat it was set in, only while that chat is there and the person started it', async () => {
    const inOwnChat = reminderRecord({
      manifest: {
        ...manifest({ task: 'In my chat', run_at: '2026-11-04T17:00:00.000Z' }),
        origin_session_id: 'chat-mine',
      },
    });
    const chatDeleted = reminderRecord({
      manifest: {
        ...manifest({ task: 'Chat deleted', run_at: '2026-11-04T17:00:00.000Z' }),
        origin_session_id: 'chat-gone',
      },
    });
    const othersChat = reminderRecord({
      manifest: {
        ...manifest({ task: 'Someone else chat', run_at: '2026-11-04T17:00:00.000Z' }),
        origin_session_id: 'chat-bob',
      },
    });
    const setElsewhere = reminderRecord({
      manifest: manifest({ task: 'Set elsewhere', run_at: '2026-11-04T17:00:00.000Z' }),
    });
    const { list } = await build({
      records: [inOwnChat, chatDeleted, othersChat, setElsewhere],
      chats: { 'chat-mine': 'alice', 'chat-bob': 'bob' },
    });

    const view = await list(ALICE);
    expect(byWhat(view.data, 'In my chat').session_id).toBe('chat-mine');
    expect(byWhat(view.data, 'Chat deleted').session_id).toBeNull();
    expect(byWhat(view.data, 'Someone else chat').session_id).toBeNull();
    expect(byWhat(view.data, 'Set elsewhere').session_id).toBeNull();
  });

  it('reads the runs of a whole page of reminders in one read, and hands back the next page token', async () => {
    const records = Array.from({ length: 30 }, (_, index) =>
      reminderRecord({ manifest: manifest({ task: `Reminder ${String(index)}`, run_at: '2026-11-04T17:00:00.000Z' }) }),
    );
    const { list, calls } = await build({ records, nextPageToken: 'next-1' });

    const view = await list(ALICE, '?limit=30&page_token=page-0');
    expect(view.data).toHaveLength(30);
    expect(view.next_page_token).toBe('next-1');
    expect(calls.listLatestRuns).toBe(1);
    expect(calls.listSchedules).toEqual([{ limit: 30, page_token: 'page-0' }]);
  });
});
