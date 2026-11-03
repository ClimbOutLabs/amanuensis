import {
  EventType,
  MAIN_THREAD_ID,
  type ISessionStore,
  type SessionRecord,
  type TerminalTurnState,
  type TurnCreatedEvent,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { ulid } from 'ulid';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { DeliveryService } from './delivery/deliveryService';
import { formatRunTime } from './scheduleCapability';

/** The line the person reads in the chat the reminder was set in. */
export function reminderLineText(input: { what: string; due: Date; timezone: string }): string {
  return `Reminder: ${input.what}\n\nDue ${formatRunTime({ at: input.due, timezone: input.timezone })}.`;
}

/** The most a feed item holds. A longer reminder keeps every word in its chat line and is cut short in the feed. */
export const REMINDER_FEED_TEXT_MAX = 2000;

function feedText(what: string): string {
  return what.length <= REMINDER_FEED_TEXT_MAX ? what : `${what.slice(0, REMINDER_FEED_TEXT_MAX - 1).trimEnd()}…`;
}

/** Where a fired reminder's line landed: the chat it was set in, or no chat at all. */
export interface ReminderDeliveryResult {
  session_id: string | null;
  turn_id: string | null;
}

/**
 * Writes one due reminder as a finished assistant line in the chat the reminder was set in, then puts it in the
 * owner's feed, which also pushes it to their devices and records it in the activity log. The host writes the
 * line itself: no model is called, so it lands at once and costs nothing.
 *
 * A reminder set outside a chat, one saved before the origin chat was recorded, and one whose chat has since
 * been deleted still fires on time: the feed item carries it with no chat line and no link, and no chat is made.
 */
export async function deliverReminder(params: {
  item: ScheduleDispatchItem;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  now: Date;
  /** The feed the reminder is also delivered through; it writes the reason to Activity. */
  deliveries: Pick<DeliveryService, 'deliver'>;
}): Promise<ReminderDeliveryResult> {
  const { item, sessionStore, now } = params;
  const { schedule, run } = item;
  const owner = schedule.created_by_subject;
  const what = schedule.manifest.task;
  const due = new Date(run.scheduled_for);
  const reason = `You asked to be reminded on ${formatRunTime({ at: due, timezone: schedule.manifest.timezone })}.`;

  const originSessionId = schedule.manifest.origin_session_id;
  const origin: SessionRecord<SessionCustom> | undefined =
    originSessionId === null
      ? undefined
      : await sessionStore.getSession({ tenant_id: schedule.tenant_id, session_id: originSessionId });

  let landed: ReminderDeliveryResult = { session_id: null, turn_id: null };
  if (origin !== undefined) {
    const text = reminderLineText({ what, due, timezone: schedule.manifest.timezone });
    const turnId = await writeReminderLine({ sessionStore, record: origin, text, now });
    landed = { session_id: origin.session_id, turn_id: turnId };
  }

  await params.deliveries.deliver({
    tenant_id: schedule.tenant_id,
    created_by: owner.subject_id,
    kind: 'reminder',
    level: 'nudge',
    text: feedText(what),
    reason,
    link: landed.session_id === null ? null : { type: 'chat', session_id: landed.session_id },
  });
  return landed;
}

/**
 * Appends the reminder line to a chat as a finished turn with no message of its own: in the chat view it joins
 * the answer above it, which is the turn where the reminder was set. Returns the turn it wrote.
 */
async function writeReminderLine(params: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  record: SessionRecord<SessionCustom>;
  text: string;
  now: Date;
}): Promise<string> {
  const { sessionStore, record, text, now } = params;
  const sessionId = record.session_id;
  const previous =
    record.last_turn_id === null
      ? undefined
      : await sessionStore.getTurn({ session_id: sessionId, turn_id: record.last_turn_id });

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
    update_session_title_if_not_exist: null,
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
  return turnId;
}
