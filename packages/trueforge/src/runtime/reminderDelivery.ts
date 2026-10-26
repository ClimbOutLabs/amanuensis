import {
  EventType,
  MAIN_THREAD_ID,
  type ISessionStore,
  type Sessions,
  type TerminalTurnState,
  type TurnCreatedEvent,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import {
  LATEST_REMINDER_AT_METADATA_KEY,
  LATEST_REMINDER_METADATA_KEY,
  REMINDERS_CHAT_TITLE,
  REMINDERS_METADATA_KEY,
} from '@truefoundry/trueforge-core/core/schedules/toolContract';
import { ulid } from 'ulid';
import type { IAgentStore } from '../db/agentStore';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { formatRunTime } from './scheduleCapability';

/** Session metadata values are capped at 128 characters. */
const METADATA_VALUE_MAX_CHARS = 128;

function remindersExternalId(subjectId: string): string {
  return `reminders:${subjectId}`;
}

function shortened(text: string): string {
  const chars = Array.from(text);
  return chars.length > METADATA_VALUE_MAX_CHARS ? `${chars.slice(0, METADATA_VALUE_MAX_CHARS - 1).join('')}…` : text;
}

/** The line the person reads in the Reminders chat. */
export function reminderLineText(input: { what: string; due: Date; timezone: string }): string {
  return `Reminder: ${input.what}\n\nDue ${formatRunTime({ at: input.due, timezone: input.timezone })}.`;
}

export class ReminderAgentNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('The assistant that set this reminder was deleted. Set the reminder again in a chat.', options);
    this.name = 'ReminderAgentNotFoundError';
  }
}

/**
 * Writes one due reminder into the owner's Reminders chat as a finished assistant line. The host writes it
 * itself: no model is called, so it lands at once and costs nothing. The chat is made on the first reminder
 * and reused after. Returns the session id.
 */
export async function deliverReminder(params: {
  item: ScheduleDispatchItem;
  sessions: Pick<Sessions<SessionCustom, TurnCustom>, 'getOrCreateByExternalId'>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  now: Date;
}): Promise<string> {
  const { item, sessions, sessionStore, agentStore, now } = params;
  const { schedule, run } = item;
  const owner = schedule.created_by_subject;
  const agent = await agentStore.getAgent({ tenant_id: schedule.tenant_id, name: schedule.agent_name });
  if (agent === undefined) {
    throw new ReminderAgentNotFoundError();
  }
  const { session: handle } = await sessions.getOrCreateByExternalId({
    tenant_id: schedule.tenant_id,
    external_id: remindersExternalId(owner.subject_id),
    created_by_subject: owner,
    agent: { type: 'reference', id: agent.id, name: agent.name },
    metadata: { [REMINDERS_METADATA_KEY]: 'true' },
  });
  const sessionId = handle.session_id;
  const record = await sessionStore.getSession({ tenant_id: schedule.tenant_id, session_id: sessionId });
  if (record === undefined) {
    throw new Error(`The Reminders chat could not be read: ${sessionId}`);
  }
  const previous =
    record.last_turn_id === null
      ? undefined
      : await sessionStore.getTurn({ session_id: sessionId, turn_id: record.last_turn_id });

  const what = schedule.manifest.task;
  const text = reminderLineText({
    what,
    due: new Date(run.scheduled_for),
    timezone: schedule.manifest.timezone,
  });
  const turnId = ulid().toLowerCase();
  const createdAt = now.toISOString();
  await sessionStore.createTurn({
    turn: {
      turn_id: turnId,
      session_id: sessionId,
      first_turn_id: previous?.first_turn_id ?? turnId,
      ancestor_ids: previous === undefined ? [] : [...previous.ancestor_ids, previous.turn_id],
      previous_turn_id: previous?.turn_id ?? null,
      state: { status: 'running' },
      input: [],
      custom: null,
      created_at: now,
      updated_at: now,
    },
    sandbox_info: null,
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: previous === undefined ? [] : [MAIN_THREAD_ID],
    new_threads:
      previous === undefined
        ? [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ]
        : [],
    new_context_appends: [
      { thread_id: MAIN_THREAD_ID, context: [{ role: 'assistant', content: text }], current_context_usage: null },
    ],
    capability_states: [
      {
        thread_id: MAIN_THREAD_ID,
        capability_state: previous?.snapshot.threads[MAIN_THREAD_ID]?.capability_state ?? null,
      },
    ],
    tool_call_memos: [],
    task_states: [],
    update_session_title_if_not_exist: REMINDERS_CHAT_TITLE,
  });

  const created: TurnCreatedEvent = {
    type: EventType.TURN_CREATED,
    id: newEventId(),
    turn_id: turnId,
    previous_turn_id: previous?.turn_id ?? null,
    state: { status: 'running' },
    created_at: createdAt,
    thread_id: null,
  };
  const output: ModelMessageEvent = {
    type: EventType.MODEL_MESSAGE,
    id: newEventId(),
    created_at: createdAt,
    thread_id: MAIN_THREAD_ID,
    content: text,
    finish_reason: 'stop',
  };
  await sessionStore.appendToEvents({ session_id: sessionId, turn_id: turnId, events: [created, output] });
  const state: TerminalTurnState = { status: 'done', output, required_actions: [], completed_at: createdAt };
  const done: TurnDoneEvent = {
    type: EventType.TURN_DONE,
    id: newEventId(),
    created_at: createdAt,
    state,
    thread_id: null,
  };
  await sessionStore.updateTurnState({ session_id: sessionId, turn_id: turnId, state, turn_done_event: done });

  // The chat list learns of a new reminder from this: the words, and when they arrived.
  await sessionStore.updateSession({
    tenant_id: schedule.tenant_id,
    session_id: sessionId,
    agent: undefined,
    title: undefined,
    metadata: {
      ...record.metadata,
      [REMINDERS_METADATA_KEY]: 'true',
      [LATEST_REMINDER_METADATA_KEY]: shortened(what),
      [LATEST_REMINDER_AT_METADATA_KEY]: createdAt,
    },
  });
  return sessionId;
}
