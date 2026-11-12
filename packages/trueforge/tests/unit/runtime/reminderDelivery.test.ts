import {
  AgentSpecSchema,
  EventType,
  MAIN_THREAD_ID,
  Sessions,
  type CreatedBySubject,
  type TerminalTurnState,
  type TurnCreatedEvent,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';
import { newEventId } from '@truefoundry/trueforge-core/core';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import winston from 'winston';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { NoticingStore } from '../../../src/db/noticingStore';
import { ReachSettingsStore } from '../../../src/db/reachSettingsStore';
import type { ScheduleDispatchItem } from '../../../src/db/scheduleStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createDeliveryService } from '../../../src/runtime/delivery/deliveryService';
import { NO_PHONE_CHANNELS } from '../../../src/runtime/noticing/reachChannels';
import { createReminderReach } from '../../../src/runtime/noticing/reminderReach';
import { REMINDER_FEED_TEXT_MAX, deliverReminder } from '../../../src/runtime/reminderDelivery';
import type { Delivery } from '../../../src/schemas/deliveries';
import type { ReachAvailability } from '../../../src/schemas/reach';
import { defaultReachSettings } from '../../../src/schemas/reach';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';

const TENANT = 'default';
const OWNER: CreatedBySubject = { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' };
const OTHER: CreatedBySubject = { subject_id: 'other-1', subject_type: 'user', subject_display_name: 'Other' };
/** Short enough that a test waits a moment, long enough that a reply ended between checks is seen. */
const LINE_WAIT = { interval_ms: 10, max_ms: 2_000 };
const COLLECTOR_EXTERNAL_ID = 'reminders:owner-1';

async function setup(channels: ReachAvailability = NO_PHONE_CHANNELS) {
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

  /**
   * Makes a chat holding one finished turn, the way a chat looks after the person asked for a reminder in it:
   * their message and the assistant's answer are both in its history.
   */
  async function originChat(input: { sessionId: string; title: string; owner?: CreatedBySubject }): Promise<string> {
    await sessionStore.createSession({
      tenant_id: TENANT,
      session_id: input.sessionId,
      created_by_subject: input.owner ?? OWNER,
      agent: { type: 'reference', id: agent.id, name: agent.name },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
      is_incognito: false,
      private_expires_at: null,
    });
    const turnId = `${input.sessionId}-turn-1`;
    const at = new Date('2026-10-19T21:00:00.000Z');
    const userText = 'Remind me later, please.';
    const assistantText = 'Done, I will remind you.';
    await sessionStore.createTurn({
      turn: {
        turn_id: turnId,
        session_id: input.sessionId,
        first_turn_id: turnId,
        ancestor_ids: [],
        previous_turn_id: null,
        state: { status: 'running' },
        input: [{ type: 'user.message', content: userText }],
        custom: null,
        created_at: at,
        updated_at: at,
      },
      sandbox_info: null,
      approval_grants: [],
      require_previous_turn_is_tip: false,
      retained_previous_thread_ids: [],
      new_threads: [
        { thread_id: MAIN_THREAD_ID, parent: null, agent_info: null, tool_call_memo: undefined, task_state: undefined },
      ],
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          context: [
            { role: 'user', content: userText },
            { role: 'assistant', content: assistantText },
          ],
          current_context_usage: null,
        },
      ],
      capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
      tool_call_memos: [],
      task_states: [],
      update_session_title_if_not_exist: input.title,
    });
    const output: ModelMessageEvent = {
      type: EventType.MODEL_MESSAGE,
      id: newEventId(),
      created_at: at.toISOString(),
      thread_id: MAIN_THREAD_ID,
      content: assistantText,
      finish_reason: 'stop',
    };
    const created: TurnCreatedEvent = {
      type: EventType.TURN_CREATED,
      id: newEventId(),
      turn_id: turnId,
      previous_turn_id: null,
      input: [{ type: 'user.message', content: userText }],
      state: { status: 'running' },
      created_at: at.toISOString(),
      thread_id: null,
    };
    await sessionStore.appendToEvents({ session_id: input.sessionId, turn_id: turnId, events: [created, output] });
    const state: TerminalTurnState = { status: 'done', output, required_actions: [], completed_at: at.toISOString() };
    const done: TurnDoneEvent = {
      type: EventType.TURN_DONE,
      id: newEventId(),
      created_at: at.toISOString(),
      state,
      thread_id: null,
    };
    await sessionStore.updateTurnState({ session_id: input.sessionId, turn_id: turnId, state, turn_done_event: done });
    return input.sessionId;
  }

  /** Makes a one-time reminder and returns the item the dispatch loop would hand over when it is due. */
  async function dueReminder(input: {
    what: string;
    runAt: string;
    name: string;
    originSessionId?: string;
    urgent?: boolean;
  }): Promise<ScheduleDispatchItem> {
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
        urgent: input.urgent ?? false,
        ...(input.originSessionId === undefined ? {} : { origin_session_id: input.originSessionId }),
      }),
      created_by_subject: OWNER,
      runFrom: new Date('2026-10-18T12:00:00.000Z'),
    });
    if (pendingRun === undefined) {
      throw new Error('Expected the reminder to queue a run');
    }
    return { run: pendingRun, schedule };
  }

  const auditRecords: AuditRecordInput[] = [];
  const deliveryStore = new DeliveryStore(db);
  const pushed: Delivery[] = [];
  const deliveries = createDeliveryService({
    store: deliveryStore,
    senders: [
      {
        channel: 'web_push',
        send: ({ delivery }) => {
          pushed.push(delivery);
          return Promise.resolve([
            {
              channel: 'web_push',
              outcome: 'sent',
              detail: null,
              target: 'device-1',
              attempted_at: new Date().toISOString(),
            },
          ]);
        },
      },
    ],
    audit: {
      record: input => {
        auditRecords.push(input);
        return Promise.resolve();
      },
    },
    logger: winston.createLogger({ silent: true }),
  });
  const logger = winston.createLogger({ silent: true });
  const reachSettings = new ReachSettingsStore(db);
  const noticingStore = new NoticingStore(db);
  const reach = createReminderReach({
    reachSettings,
    store: noticingStore,
    history: deliveryStore,
    channels: () => channels,
    logger,
  });
  const fire = (item: ScheduleDispatchItem, now: Date, lineWait = LINE_WAIT) =>
    deliverReminder({ item, sessionStore, now, deliveries, reach, logger, lineWait });
  /** Fires a reminder and waits for its chat line, the way the person sees it once everything has landed. */
  async function deliver(item: ScheduleDispatchItem, now: Date) {
    const delivered = await fire(item, now);
    return { session_id: delivered.session_id, turn_id: await delivered.line };
  }

  /** Starts a reply in a chat that is still running, as when the person is mid-conversation. Returns its end. */
  async function runningReply(sessionId: string): Promise<() => Promise<void>> {
    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: sessionId });
    const previous =
      session?.last_turn_id == null
        ? undefined
        : await sessionStore.getTurn({ session_id: sessionId, turn_id: session.last_turn_id });
    if (previous === undefined) {
      throw new Error('Expected the chat to hold a turn');
    }
    const turnId = `${sessionId}-running`;
    const at = new Date('2026-10-19T22:00:00.000Z');
    await sessionStore.createTurn({
      turn: {
        turn_id: turnId,
        session_id: sessionId,
        first_turn_id: previous.first_turn_id,
        ancestor_ids: [...previous.ancestor_ids, previous.turn_id],
        previous_turn_id: previous.turn_id,
        state: { status: 'running' },
        input: [{ type: 'user.message', content: 'Another question.' }],
        custom: null,
        created_at: at,
        updated_at: at,
      },
      sandbox_info: null,
      approval_grants: [],
      require_previous_turn_is_tip: false,
      retained_previous_thread_ids: [MAIN_THREAD_ID],
      new_threads: [],
      new_context_appends: [],
      capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
      tool_call_memos: [],
      task_states: [],
      update_session_title_if_not_exist: null,
    });
    return async () => {
      const output: ModelMessageEvent = {
        type: EventType.MODEL_MESSAGE,
        id: newEventId(),
        created_at: at.toISOString(),
        thread_id: MAIN_THREAD_ID,
        content: 'An answer.',
        finish_reason: 'stop',
      };
      const state: TerminalTurnState = { status: 'done', output, required_actions: [], completed_at: at.toISOString() };
      const done: TurnDoneEvent = {
        type: EventType.TURN_DONE,
        id: newEventId(),
        created_at: at.toISOString(),
        state,
        thread_id: null,
      };
      await sessionStore.updateTurnState({ session_id: sessionId, turn_id: turnId, state, turn_done_event: done });
    };
  }

  async function listAllSessions() {
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
      include_private: false,
    });
    return all.data;
  }

  const collectorSession = () => sessions.getByExternalId({ tenant_id: TENANT, external_id: COLLECTOR_EXTERNAL_ID });

  return {
    sessionStore,
    originChat,
    dueReminder,
    deliver,
    fire,
    runningReply,
    auditRecords,
    deliveryStore,
    pushed,
    listAllSessions,
    collectorSession,
    reachSettings,
    noticingStore,
  };
}

describe('deliverReminder and Reach me', () => {
  const owner = { tenant_id: TENANT, created_by: OWNER.subject_id };
  const READY: ReachAvailability = { ...NO_PHONE_CHANNELS, calls: { available: true, note: 'Calls are on.' } };
  const calling = {
    ...defaultReachSettings('America/New_York'),
    channels: { texts: false, calls: true },
    call_for_urgent_reminders: true,
    quiet_hours: { enabled: false, start: '21:00', end: '08:00' },
  };

  it('delivers an urgent reminder as a nudge with the reason while no phone channel is set up', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings } = await setup(NO_PHONE_CHANNELS);
    await reachSettings.put({ ...owner, settings: calling });
    const item = await dueReminder({
      what: 'Pick up the keys',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-urgent',
      urgent: true,
    });

    await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    const [delivered] = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries;
    expect(delivered).toMatchObject({ kind: 'reminder', level: 'nudge' });
    expect(delivered?.reason).toContain('Phone calls are not set up yet, so it came as a nudge.');
  });

  it('calls for an urgent reminder once a phone channel is on', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings } = await setup(READY);
    await reachSettings.put({ ...owner, settings: calling });
    const item = await dueReminder({
      what: 'Pick up the keys',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-call',
      urgent: true,
    });

    await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    const [delivered] = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries;
    expect(delivered).toMatchObject({ kind: 'reminder', level: 'call' });
  });

  it('never calls for a reminder that is not marked urgent, or when the tick is off', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings } = await setup(READY);
    await reachSettings.put({ ...owner, settings: calling });
    await deliver(
      await dueReminder({ what: 'Water plants', runAt: '2026-10-19T18:00:00-04:00', name: 'r-plain' }),
      new Date('2026-10-19T22:00:05.000Z'),
    );
    await reachSettings.put({ ...owner, settings: { ...calling, call_for_urgent_reminders: false } });
    await deliver(
      await dueReminder({ what: 'Pay rent', runAt: '2026-10-19T19:00:00-04:00', name: 'r-off', urgent: true }),
      new Date('2026-10-19T23:00:05.000Z'),
    );
    const levels = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries.map(item => item.level);
    expect(levels).toEqual(['nudge', 'nudge']);
  });

  it('keeps a call from repeating inside the minimum gap', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings } = await setup(READY);
    await reachSettings.put({ ...owner, settings: calling });
    await deliver(
      await dueReminder({ what: 'First', runAt: '2026-10-19T18:00:00-04:00', name: 'r-1', urgent: true }),
      new Date('2026-10-19T22:00:05.000Z'),
    );
    await deliver(
      await dueReminder({ what: 'Second', runAt: '2026-10-19T18:30:00-04:00', name: 'r-2', urgent: true }),
      new Date('2026-10-19T22:30:05.000Z'),
    );
    const levels = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries.map(item => item.level);
    expect(levels).toEqual(['nudge', 'call']);
  });

  it('lets a call through after a call that only went out as a nudge', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings } = await setup(READY);
    await reachSettings.put({ ...owner, settings: calling });
    // An urgent reminder from before calls were set up, which went out as a nudge.
    await deliveryStore.create({
      ...owner,
      kind: 'reminder',
      level: 'nudge',
      text: 'First',
      reason: 'Phone calls are not set up yet, so it came as a nudge.',
      link: null,
      created_at: new Date('2026-10-19T22:00:05.000Z'),
    });
    await deliver(
      await dueReminder({ what: 'Second', runAt: '2026-10-19T18:30:00-04:00', name: 'r-2', urgent: true }),
      new Date('2026-10-19T22:30:05.000Z'),
    );
    const [newest] = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries;
    expect(newest).toMatchObject({ text: expect.stringContaining('Second'), level: 'call' });
  });

  it('writes nothing to the noticing records, so reminders never use up the nudges for the day', async () => {
    const { dueReminder, deliver, noticingStore } = await setup(NO_PHONE_CHANNELS);
    await deliver(
      await dueReminder({ what: 'Water plants', runAt: '2026-10-19T18:00:00-04:00', name: 'r-plain' }),
      new Date('2026-10-19T22:00:05.000Z'),
    );
    const kinds = ['mail_always', 'calendar_clash', 'travel', 'bill_due', 'approval_waiting'] as const;
    await expect(
      noticingStore.listPending({ ...owner, kinds, stale_before: new Date('2030-01-01'), limit: 10 }),
    ).resolves.toEqual([]);
  });

  it('still delivers an urgent reminder once when handing back the reach lease fails', async () => {
    const { dueReminder, deliver, deliveryStore, reachSettings, noticingStore } = await setup(READY);
    await reachSettings.put({ ...owner, settings: calling });
    jest.spyOn(noticingStore, 'releaseReachLease').mockRejectedValueOnce(new Error('database went away'));
    await deliver(
      await dueReminder({ what: 'Pick up the keys', runAt: '2026-10-19T18:00:00-04:00', name: 'r-l8', urgent: true }),
      new Date('2026-10-19T22:00:05.000Z'),
    );
    const delivered = (await deliveryStore.list({ ...owner, limit: 10 })).deliveries;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ level: 'call' });
  });
});

describe('deliverReminder', () => {
  it('makes a reminder delivery for the owner and pushes it, with no tab open', async () => {
    const { originChat, dueReminder, deliver, deliveryStore, pushed } = await setup();
    const originId = await originChat({ sessionId: 'chat-medicine', title: 'Medicine' });
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-one',
      originSessionId: originId,
    });

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered.session_id).toBe(originId);
    const owner = { tenant_id: TENANT, created_by: OWNER.subject_id };
    const page = await deliveryStore.list({ ...owner, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]).toMatchObject({
      kind: 'reminder',
      level: 'nudge',
      text: 'Take the medicine',
      reason: 'You asked to be reminded on Monday, October 19 at 6:00 PM.',
      link: { type: 'chat', session_id: originId },
      seen_at: null,
    });
    expect(page.deliveries[0]?.attempts.map(a => [a.channel, a.outcome])).toEqual([
      ['in_app', 'sent'],
      ['web_push', 'sent'],
    ]);
    expect(pushed.map(d => d.id)).toEqual([page.deliveries[0]?.id]);
    await expect(deliveryStore.countUnread(owner)).resolves.toBe(1);
  });

  it('delivers a very long reminder: every word in the chat, a shortened item in the feed', async () => {
    const { originChat, dueReminder, deliver, deliveryStore, sessionStore } = await setup();
    const originId = await originChat({ sessionId: 'chat-forms', title: 'Forms' });
    const what = 'Bring the forms. '.repeat(200).trim();
    const item = await dueReminder({
      what,
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-long',
      originSessionId: originId,
    });

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered.session_id).toBe(originId);
    const [feed] = (await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 1 })).deliveries;
    expect(feed?.text.length).toBeLessThanOrEqual(REMINDER_FEED_TEXT_MAX);
    expect(feed?.text.endsWith('…')).toBe(true);
    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: originId });
    const turn =
      session?.last_turn_id == null
        ? undefined
        : await sessionStore.getTurn({ session_id: originId, turn_id: session.last_turn_id });
    expect(turn?.state).toMatchObject({ status: 'done', output: { content: expect.stringContaining(what) } });
  });

  it('records the delivery and each channel tried in the activity log, with the reason', async () => {
    const { originChat, dueReminder, deliver, auditRecords } = await setup();
    const originId = await originChat({ sessionId: 'chat-medicine', title: 'Medicine' });
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-one',
      originSessionId: originId,
    });

    await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(auditRecords.map(r => r.tool_name)).toEqual(['delivery.created', 'delivery.web_push']);
    expect(auditRecords[0]).toMatchObject({
      tenant_id: TENANT,
      created_by: OWNER.subject_id,
      conversation_id: originId,
      tier: 1,
      outcome: 'logged',
    });
    expect(auditRecords[0]?.description).toContain('Take the medicine');
    expect(auditRecords[0]?.description).toContain('You asked to be reminded on Monday, October 19 at 6:00 PM.');
  });

  it('writes a due reminder, with its time, into the chat it was set in, under its own name', async () => {
    const { sessionStore, originChat, dueReminder, deliver, collectorSession } = await setup();
    const originId = await originChat({ sessionId: 'chat-medicine', title: 'Medicine chat' });
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-one',
      originSessionId: originId,
    });

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered.session_id).toBe(originId);
    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: originId });
    expect(session).toMatchObject({ title: 'Medicine chat', created_by_subject: OWNER, metadata: {} });
    const turn = await sessionStore.getTurn({ session_id: originId, turn_id: session?.last_turn_id ?? '' });
    expect(turn?.state).toMatchObject({ status: 'done' });
    const text = 'Reminder: Take the medicine\n\nDue Monday, October 19 at 6:00 PM.';
    expect(turn?.state.status === 'done' ? turn.state.output?.content : undefined).toBe(text);
    // The line joins the chat's own history, after the exchange that set the reminder.
    expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([
      { role: 'user', content: 'Remind me later, please.' },
      { role: 'assistant', content: 'Done, I will remind you.' },
      { role: 'assistant', content: text },
    ]);
    // The session event stream the chat view rebuilds from holds the line as a model message on the new turn,
    // chained after the turn that set the reminder, with no message of its own.
    const events = await sessionStore.listSessionEvents({
      session_id: originId,
      limit: 50,
      page_token: undefined,
      last_turn_id: undefined,
      types: undefined,
      after_event_id: undefined,
    });
    const reminderEvents = events.data.filter(item => item.turn_id === delivered.turn_id).map(item => item.event);
    expect(reminderEvents.map(event => event.type)).toEqual(['turn.done', 'model.message', 'turn.created']);
    const createdEvent = reminderEvents.find(event => event.type === 'turn.created');
    expect(createdEvent?.type === 'turn.created' ? createdEvent.previous_turn_id : undefined).toBe(
      `${originId}-turn-1`,
    );
    expect(createdEvent?.type === 'turn.created' ? createdEvent.input : undefined).toBeUndefined();
    const messageEvent = reminderEvents.find(event => event.type === 'model.message');
    expect(messageEvent?.type === 'model.message' ? messageEvent.content : undefined).toBe(text);
    await expect(collectorSession()).resolves.toBeUndefined();
  });

  it('gives two chats only their own reminders, and never makes a shared chat', async () => {
    const { sessionStore, originChat, dueReminder, deliver, deliveryStore, listAllSessions, collectorSession } =
      await setup();
    const medicineChat = await originChat({ sessionId: 'chat-medicine', title: 'Medicine chat' });
    const dentistChat = await originChat({ sessionId: 'chat-dentist', title: 'Dentist chat' });
    const first = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-one',
      originSessionId: medicineChat,
    });
    const second = await dueReminder({
      what: 'Call the dentist',
      runAt: '2026-10-19T19:00:00-04:00',
      name: 'r-two',
      originSessionId: dentistChat,
    });

    const firstDelivered = await deliver(first, new Date('2026-10-19T22:00:05.000Z'));
    const secondDelivered = await deliver(second, new Date('2026-10-19T23:00:05.000Z'));

    expect(firstDelivered.session_id).toBe(medicineChat);
    expect(secondDelivered.session_id).toBe(dentistChat);
    expect(await listAllSessions()).toHaveLength(2);
    await expect(collectorSession()).resolves.toBeUndefined();

    const medicineTurns = await sessionStore.listTurns({ session_id: medicineChat, limit: 10, page_token: undefined });
    expect(medicineTurns.data).toHaveLength(2);
    const medicineReminder = medicineTurns.data.find(turn => turn.turn_id === firstDelivered.turn_id);
    expect(medicineReminder?.state.status === 'done' ? medicineReminder.state.output?.content : undefined).toContain(
      'Take the medicine',
    );
    const dentistTurns = await sessionStore.listTurns({ session_id: dentistChat, limit: 10, page_token: undefined });
    expect(dentistTurns.data).toHaveLength(2);
    const dentistReminder = dentistTurns.data.find(turn => turn.turn_id === secondDelivered.turn_id);
    expect(dentistReminder?.state.status === 'done' ? dentistReminder.state.output?.content : undefined).toContain(
      'Call the dentist',
    );

    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    const links = page.deliveries.map(delivery => (delivery.link?.type === 'chat' ? delivery.link.session_id : null));
    expect(links).toContain(medicineChat);
    expect(links).toContain(dentistChat);
  });

  it('fires a reminder saved before origins were recorded through the bell alone, and makes no chat', async () => {
    const { dueReminder, deliver, deliveryStore, listAllSessions, collectorSession } = await setup();
    const item = await dueReminder({ what: 'Take the medicine', runAt: '2026-10-19T18:00:00-04:00', name: 'r-legacy' });
    expect(item.schedule.manifest.origin_session_id).toBeNull();

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered).toEqual({ session_id: null, turn_id: null });
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]).toMatchObject({ kind: 'reminder', text: 'Take the medicine', link: null });
    expect(await listAllSessions()).toHaveLength(0);
    await expect(collectorSession()).resolves.toBeUndefined();
  });

  it('fires through the bell alone when the chat it was set in has been deleted, and makes no chat', async () => {
    const { sessionStore, originChat, dueReminder, deliver, deliveryStore, listAllSessions, collectorSession } =
      await setup();
    const originId = await originChat({ sessionId: 'chat-gone', title: 'Short lived chat' });
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-gone',
      originSessionId: originId,
    });
    await sessionStore.deleteSession({ tenant_id: TENANT, session_id: originId });

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered).toEqual({ session_id: null, turn_id: null });
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]).toMatchObject({ kind: 'reminder', text: 'Take the medicine', link: null });
    expect(await listAllSessions()).toHaveLength(0);
    await expect(collectorSession()).resolves.toBeUndefined();
  });

  it('never writes into a chat someone else started, even when the reminder names it', async () => {
    const { sessionStore, originChat, dueReminder, deliver, deliveryStore } = await setup();
    const othersChat = await originChat({ sessionId: 'chat-other', title: 'Not yours', owner: OTHER });
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-foreign',
      originSessionId: othersChat,
    });

    const delivered = await deliver(item, new Date('2026-10-19T22:00:05.000Z'));

    expect(delivered).toEqual({ session_id: null, turn_id: null });
    const turns = await sessionStore.listTurns({ session_id: othersChat, limit: 10, page_token: undefined });
    expect(turns.data).toHaveLength(1);
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]).toMatchObject({ kind: 'reminder', text: 'Take the medicine', link: null });
    const othersFeed = await deliveryStore.list({ tenant_id: TENANT, created_by: OTHER.subject_id, limit: 10 });
    expect(othersFeed.deliveries).toHaveLength(0);
  });

  it('puts the reminder in the feed at once while a reply runs in its chat, and writes the line when it ends', async () => {
    const { sessionStore, originChat, dueReminder, fire, runningReply, deliveryStore } = await setup();
    const originId = await originChat({ sessionId: 'chat-busy', title: 'Busy chat' });
    const endReply = await runningReply(originId);
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-busy',
      originSessionId: originId,
    });

    const delivered = await fire(item, new Date());

    expect(delivered.session_id).toBe(originId);
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]).toMatchObject({ link: { type: 'chat', session_id: originId } });
    const before = await sessionStore.listTurns({ session_id: originId, limit: 10, page_token: undefined });
    expect(before.data).toHaveLength(2);

    await endReply();
    const lineTurnId = await delivered.line;

    expect(lineTurnId).not.toBeNull();
    const session = await sessionStore.getSession({ tenant_id: TENANT, session_id: originId });
    expect(session?.last_turn_id).toBe(lineTurnId);
    const turn = await sessionStore.getTurn({ session_id: originId, turn_id: lineTurnId ?? '' });
    expect(turn?.previous_turn_id).toBe(`${originId}-running`);
    expect(turn?.state.status === 'done' ? turn.state.output?.content : undefined).toContain('Take the medicine');
  });

  it('keeps the reminder in the feed when a reply in its chat never ends, and gives up on the line', async () => {
    const { sessionStore, originChat, dueReminder, fire, runningReply, deliveryStore } = await setup();
    const originId = await originChat({ sessionId: 'chat-stuck', title: 'Stuck chat' });
    await runningReply(originId);
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-stuck',
      originSessionId: originId,
    });

    const delivered = await fire(item, new Date(), { interval_ms: 5, max_ms: 30 });

    await expect(delivered.line).resolves.toBeNull();
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
    const turns = await sessionStore.listTurns({ session_id: originId, limit: 10, page_token: undefined });
    expect(turns.data).toHaveLength(2);
  });

  it('drops the line, not the reminder, when its chat is deleted while a reply runs there', async () => {
    const { sessionStore, originChat, dueReminder, fire, runningReply, deliveryStore } = await setup();
    const originId = await originChat({ sessionId: 'chat-deleted-busy', title: 'Busy then gone' });
    await runningReply(originId);
    const item = await dueReminder({
      what: 'Take the medicine',
      runAt: '2026-10-19T18:00:00-04:00',
      name: 'r-deleted-busy',
      originSessionId: originId,
    });

    const delivered = await fire(item, new Date());
    await sessionStore.deleteSession({ tenant_id: TENANT, session_id: originId });

    await expect(delivered.line).resolves.toBeNull();
    const page = await deliveryStore.list({ tenant_id: TENANT, created_by: OWNER.subject_id, limit: 10 });
    expect(page.deliveries).toHaveLength(1);
  });
});
