import {
  EventType,
  MAIN_THREAD_ID,
  type ISessionStore,
  type TerminalTurnState,
  type TurnContextAppend,
  type TurnCreatedEvent,
  type TurnDoneEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { newEventId } from '@truefoundry/trueforge-core/core';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import { ulid } from 'ulid';

import type { SessionCustom, TurnCustom } from '../db/sessionCustom';

/**
 * Writes one finished assistant line at the end of a chat, with no model call, the way the chat shows any reply. Later
 * turns in the chat see it as the assistant's own words. Resolves to the turn it wrote.
 */
export async function appendAssistantLine({
  sessionStore,
  tenant_id,
  session_id,
  text,
  title,
  now,
}: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  tenant_id: string;
  session_id: string;
  text: string;
  /** Becomes the chat's title when it has none yet. */
  title: string;
  now: Date;
}): Promise<string> {
  const record = await sessionStore.getSession({ tenant_id, session_id });
  if (record === undefined) {
    throw new Error(`The chat could not be read: ${session_id}`);
  }
  const previous =
    record.last_turn_id === null ? undefined : await sessionStore.getTurn({ session_id, turn_id: record.last_turn_id });
  const context: TurnContextAppend['context'] = [{ role: 'assistant', content: text }];
  const turnId = ulid().toLowerCase();
  const createdAt = now.toISOString();
  await sessionStore.createTurn({
    turn: {
      turn_id: turnId,
      session_id,
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
      {
        thread_id: MAIN_THREAD_ID,
        context,
        current_context_usage: null,
      },
    ],
    capability_states: [
      {
        thread_id: MAIN_THREAD_ID,
        capability_state: previous?.snapshot.threads[MAIN_THREAD_ID]?.capability_state ?? null,
      },
    ],
    tool_call_memos: [],
    task_states: [],
    update_session_title_if_not_exist: title,
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
  await sessionStore.appendToEvents({ session_id, turn_id: turnId, events: [created, output] });
  const state: TerminalTurnState = { status: 'done', output, required_actions: [], completed_at: createdAt };
  const done: TurnDoneEvent = {
    type: EventType.TURN_DONE,
    id: newEventId(),
    created_at: createdAt,
    state,
    thread_id: null,
  };
  await sessionStore.updateTurnState({ session_id, turn_id: turnId, state, turn_done_event: done });
  return turnId;
}
