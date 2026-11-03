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
  pending?: Record<string, ScheduleRunRecord>;
  runs?: Record<string, ScheduleRunRecord[]>;
  withChat?: boolean;
}) {
  const scheduleStore: RemindersRouterDeps<never>['scheduleStore'] = {
    listSchedules: async query => {
      const mine = input.records.filter(
        record =>
          record.tenant_id === query.tenant_id &&
          record.created_by_subject.subject_id === query.created_by_or_agent_ids?.created_by_subject_id,
      );
      return { data: mine, pagination: { limit: query.limit } };
    },
    getScheduledRunFor: async query => input.pending?.[query.schedule_id],
    listRuns: async query => ({
      data: (input.runs?.[query.schedule_id] ?? []).slice(0, query.limit),
      pagination: { limit: query.limit },
    }),
  };
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  if (input.withChat === true) {
    await sessionStore.createSession({
      tenant_id: 'default',
      session_id: 'reminders-session-1',
      agent: { type: 'reference', id: 'agent-1', name: 'chat-assistant-alice' },
      created_by_subject: OWNER,
      external_id: 'reminders:alice',
      metadata: { is_reminders: 'true' },
      source: null,
      custom: null,
    });
    await sessionStore.updateSession({
      tenant_id: 'default',
      session_id: 'reminders-session-1',
      agent: undefined,
      title: 'Reminders',
      metadata: undefined,
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
  const list = async (as: RequestContext) => {
    current = as;
    const response = await app.request('/reminders');
    expect(response.status).toBe(200);
    return ListRemindersResponseSchema.parse(await response.json());
  };
  return { list };
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
      pending: { [record.id]: runRecord({ schedule_id: record.id, scheduled_for: '2026-11-04T17:00:00.000Z' }) },
    });

    const view = await list(ALICE);
    expect(view.reminders_chat).toBeNull();
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
      withChat: true,
    });

    const view = await list(ALICE);
    const item = byWhat(view.data, 'Call the dentist');
    expect(item.state).toBe('reminded');
    expect(item.next_due_at).toBeNull();
    expect(item.last_reminded_at).toBe('2026-11-02T17:00:05.000Z');
    expect(item.last_due_at).toBe('2026-11-02T17:00:00.000Z');
    expect(view.reminders_chat).toEqual({ session_id: 'reminders-session-1', title: 'Reminders' });
  });

  it('keeps a repeating reminder upcoming after a firing, and remembers the last one', async () => {
    const record = reminderRecord({
      manifest: manifest({ task: 'Water the plants', cron: '0 9 * * *' }),
    });
    const { list } = await build({
      records: [record],
      pending: { [record.id]: runRecord({ schedule_id: record.id, scheduled_for: '2026-11-04T17:00:00.000Z' }) },
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
      pending: { [record.id]: runRecord({ schedule_id: record.id }) },
    });

    const item = byWhat((await list(ALICE)).data, 'Stretch');
    expect(item.persona_name).toBe('chat-assistant-alice');
  });
});
