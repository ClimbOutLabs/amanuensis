import {
  EventType,
  MAIN_THREAD_ID,
  PreviousTurnRunningError,
  SessionNotFoundError,
  type ISessionStore,
  type SessionRecord,
  type TerminalTurnState,
  type TurnCreatedEvent,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { ulid } from 'ulid';
import type { Logger } from 'winston';
import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { DeliveryService } from './delivery/deliveryService';
import { joinReasons } from './noticing/reachRules';
import type { ReminderReach } from './noticing/reminderReach';
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

/** How long a reminder line waits for a reply running in its chat to end, and how often it looks. */
export interface ReminderLineWait {
  interval_ms: number;
  max_ms: number;
}

/** Replies end well inside this; a turn still running after it is one a stopped server left behind. */
const DEFAULT_LINE_WAIT: ReminderLineWait = { interval_ms: 5_000, max_ms: 30 * 60_000 };

/**
 * Where a fired reminder went. `session_id` is the chat its feed item links to, or null when it has no chat.
 * `line` settles with the turn that holds the reminder line once it is written (null when no line is written); it
 * never rejects.
 */
export interface ReminderDeliveryResult {
  session_id: string | null;
  line: Promise<string | null>;
}

/**
 * Puts one due reminder in the owner's feed, which also pushes it to their devices and records it in the activity
 * log, then writes it as a finished assistant line in the chat it was set in. The host writes the line itself: no
 * model is called, so it costs nothing.
 *
 * The feed item goes first so nothing in the chat can hold it back. A reply still running in the chat holds the
 * line until that reply ends. The line only lands in a chat the reminder's owner started: a reminder whose chat
 * is gone, belongs to someone else, or was never recorded still fires, in the feed only, with no link.
 */
export async function deliverReminder(params: {
  item: ScheduleDispatchItem;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  now: Date;
  /** The feed the reminder is also delivered through; it writes the reason to Activity. */
  deliveries: Pick<DeliveryService, 'deliver'>;
  /** Settles how loud the reminder is, by the person's own rules for the channels. */
  reach: ReminderReach;
  logger: Logger;
  /** Runs once the line is in the chat, which can be after a reply running there ends. */
  onLineWritten?: (line: { session_id: string; turn_id: string }) => Promise<void>;
  lineWait?: ReminderLineWait;
}): Promise<ReminderDeliveryResult> {
  const { item, sessionStore, now, logger } = params;
  const { schedule, run } = item;
  const owner = schedule.created_by_subject;
  const what = schedule.manifest.task;
  const due = new Date(run.scheduled_for);
  const reason = `You asked to be reminded on ${formatRunTime({ at: due, timezone: schedule.manifest.timezone })}.`;

  const originSessionId = schedule.manifest.origin_session_id;
  const origin =
    originSessionId === null
      ? undefined
      : await sessionStore.getSession({ tenant_id: schedule.tenant_id, session_id: originSessionId });
  // The line only goes into a chat the reminder's owner started.
  const chatId = origin?.created_by_subject.subject_id === owner.subject_id ? origin.session_id : null;

  const person = { tenant_id: schedule.tenant_id, created_by: owner.subject_id };
  await params.reach.deliver({
    owner: person,
    urgent: schedule.manifest.urgent,
    timezone: schedule.manifest.timezone,
    at: now,
    send: decision =>
      params.deliveries.deliver({
        ...person,
        kind: 'reminder',
        level: decision.delivered,
        text: feedText(what),
        reason: joinReasons([reason, ...decision.steps]),
        link: chatId === null ? null : { type: 'chat', session_id: chatId },
        created_at: now,
      }),
  });
  if (chatId === null) {
    return { session_id: null, line: Promise.resolve(null) };
  }

  const text = reminderLineText({ what, due, timezone: schedule.manifest.timezone });
  const lineParams = { sessionStore, tenant_id: schedule.tenant_id, session_id: chatId, text };
  const logFailure = (error: unknown): null => {
    // The feed item already carries the reminder; only its copy in the chat is missing.
    logger.warn('Could not write a reminder line into its chat', {
      schedule_id: schedule.id,
      run_id: run.id,
      session_id: chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };
  const landed = async (turnId: string | null): Promise<string | null> => {
    if (turnId !== null) {
      await params.onLineWritten?.({ session_id: chatId, turn_id: turnId });
    }
    return turnId;
  };

  let first: string | null | typeof CHAT_BUSY;
  try {
    first = await tryWriteReminderLine(lineParams);
  } catch (error) {
    return { session_id: chatId, line: Promise.resolve(logFailure(error)) };
  }
  if (first !== CHAT_BUSY) {
    return { session_id: chatId, line: Promise.resolve(await landed(first)) };
  }
  // A reply is running in the chat. The line waits for it without holding back the run that fired the reminder.
  const wait = params.lineWait ?? DEFAULT_LINE_WAIT;
  const line = writeReminderLineWhenFree({ ...lineParams, wait, startedAt: now })
    .then(landed)
    .catch(logFailure);
  return { session_id: chatId, line };
}

const CHAT_BUSY = Symbol('chat busy');

/** One try at the line: its turn, null when the chat is gone, or CHAT_BUSY while a reply runs there. */
async function tryWriteReminderLine(params: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  tenant_id: string;
  session_id: string;
  text: string;
}): Promise<string | null | typeof CHAT_BUSY> {
  const { sessionStore, tenant_id, session_id, text } = params;
  const record = await sessionStore.getSession({ tenant_id, session_id });
  if (record === undefined) {
    return null;
  }
  try {
    return await writeReminderLine({ sessionStore, record, text, now: new Date() });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return null;
    }
    if (error instanceof PreviousTurnRunningError) {
      return CHAT_BUSY;
    }
    throw error;
  }
}

/** Tries again until the reply ends. Returns null when the chat is deleted meanwhile or the wait runs out. */
async function writeReminderLineWhenFree(params: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  tenant_id: string;
  session_id: string;
  text: string;
  wait: ReminderLineWait;
  startedAt: Date;
}): Promise<string | null> {
  const { wait, startedAt } = params;
  const deadline = startedAt.getTime() + wait.max_ms;
  for (;;) {
    if (Date.now() + wait.interval_ms > deadline) {
      throw new Error('A reply in the chat was still running when the reminder line stopped waiting');
    }
    await new Promise(resolve => setTimeout(resolve, wait.interval_ms));
    const result = await tryWriteReminderLine(params);
    if (result !== CHAT_BUSY) {
      return result;
    }
  }
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
    approval_refusals: [],
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
