import {
  AgentSpecSchema,
  MAIN_THREAD_ID,
  Sessions,
  type CreatedBySubject,
} from '@truefoundry/trueforge-core/agent-session';
import {
  LATEST_REMINDER_AT_METADATA_KEY,
  LATEST_REMINDER_METADATA_KEY,
  REMINDERS_CHAT_TITLE,
  REMINDERS_METADATA_KEY,
} from '@truefoundry/trueforge-core/core/schedules/toolContract';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ScheduleDispatchItem } from '../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { deliverReminder } from '../../../src/runtime/reminderDelivery';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';

const TENANT = 'default';
const OWNER: CreatedBySubject = { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' };

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const scheduleStore = new SqliteScheduleStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const sessions = new Sessions({ sessionStore });
  const agent = await agentStore.createAgent({
    host_managed: true,
    tenant_id: TENANT,
    created_by_subject: OWNER,
    name: 'assistant-0123456789abcdef',
    description: 'Runs the schedules you make in a chat.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: null,
  });

  /** Makes a one-time reminder and returns the item the dispatch loop would hand over when it is due. */
  async function dueReminder(input: { what: string; runAt: string; name: string }): Promise<ScheduleDispatchItem> {
    const { schedule, pendingRun } = await scheduleStore.createScheduleAndRun({
      tenant_id: TENANT,
      agent_id: agent.id,
      agent_name: agent.name,
      persona_id: null,
      name: input.name,
      manifest: ScheduleManifestSchema.parse({
        task: input.what,
        run_at: input.runAt,
        timezone: 'America/New_York',
        kind: 'reminder',
      }),
      created_by_subject: OWNER,
      runFrom: new Date('2026-10-18T12:00:00.000Z'),
    });
    if (pendingRun === undefined) {
      throw new Error('Expected the reminder to queue a run');
    }
    return { run: pendingRun, schedule };
  }

  const deliver = (item: ScheduleDispatchItem, now: Date) =>
    deliverReminder({ item, sessions, sessionStore, agentStore, now });

  return { sessionStore, dueReminder, deliver };
}

describe('deliverReminder', () => {
  it('writes a due reminder, with its time, into one chat named Reminders, with no model call', async () => {
    const { sessionStore, dueReminder, deliver } = await setup();
    const item = await dueReminder({ what: 'Take the medicine', runAt: '2026-10-19T18:00:00-04:00', name: 'r-one' });

    const sessionId = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: sessionId });
    expect(session).toMatchObject({
      title: REMINDERS_CHAT_TITLE,
      created_by_subject: OWNER,
      metadata: {
        [REMINDERS_METADATA_KEY]: 'true',
        [LATEST_REMINDER_METADATA_KEY]: 'Take the medicine',
        [LATEST_REMINDER_AT_METADATA_KEY]: '2026-10-19T22:00:05.000Z',
      },
    });
    const turn = await sessionStore.getTurn({ session_id: sessionId, turn_id: session?.last_turn_id ?? '' });
    expect(turn?.state).toMatchObject({ status: 'done' });
    const text = 'Reminder: Take the medicine\n\nDue Monday, October 19 at 6:00 PM.';
    expect(turn?.state.status === 'done' ? turn.state.output?.content : undefined).toBe(text);
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([{ role: 'assistant', content: text }]);
  });

  it('puts every later reminder in that same chat, never a new one per reminder', async () => {
    const { sessionStore, dueReminder, deliver } = await setup();
    const first = await dueReminder({ what: 'Take the medicine', runAt: '2026-10-19T18:00:00-04:00', name: 'r-one' });
    const second = await dueReminder({ what: 'Call the dentist', runAt: '2026-10-19T19:00:00-04:00', name: 'r-two' });

    const firstId = await deliver(first, new Date('2026-10-19T22:00:05.000Z'));
    const secondId = await deliver(second, new Date('2026-10-19T23:00:05.000Z'));

    expect(secondId).toBe(firstId);
    const all = await sessionStore.listSessions({
      tenant_id: TENANT,
      limit: 50,
      page_token: undefined,
      order: undefined,
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      folder_id: undefined,
      no_folder: false,
      created_by_or_agent_ids: undefined,
      metadata: undefined,
      source_type: undefined,
      source_id: undefined,
    });
    expect(all.data).toHaveLength(1);
    const turns = await sessionStore.listTurns({ session_id: firstId, limit: 10, page_token: undefined });
    expect(turns.data).toHaveLength(2);
    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: firstId });
    expect(session?.metadata[LATEST_REMINDER_METADATA_KEY]).toBe('Call the dentist');
  });
});
