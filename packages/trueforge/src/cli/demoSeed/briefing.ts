import {
  EventType,
  MAIN_THREAD_ID,
  type ISessionStore,
  type TerminalTurnState,
  type TurnCreatedEvent,
  type TurnInputItem,
} from '@truefoundry/trueforge-core/agent-session';
import {
  createToolResponseV2,
  newEventId,
  type ContextMessage,
  type ModelMessageEvent,
} from '@truefoundry/trueforge-core/core';
import { ulid } from 'ulid';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { FormattedMemoryBlock } from '../../runtime/memory/memoryCapability';
import type { MemoryRecallPersistedEvent } from '../../schemas/memoryEvents';
import type { DemoBriefing } from './world';

const ROUTE_CALL_ID = 'call_demo_synthetic_route';
const MAPS_SERVER_ID = 'maps';
const ROUTE_TOOL_NAME = 'render_route';
/** Spacing between the turn's events so the timeline reads in the order it ran. */
const STEP_MS = 1500;

/**
 * Persists one finished briefing turn through the session store, in the order a live run writes it:
 * the turn and its user message, the memory recall, the route call and its approved result, the
 * final brief, and the terminal state. The chat then opens and continues like any other.
 */
export async function seedBriefingTurn({
  store,
  sessionId,
  briefing,
  memoryBlock,
  now,
}: {
  store: ISessionStore<SessionCustom, TurnCustom>;
  sessionId: string;
  briefing: DemoBriefing;
  memoryBlock: FormattedMemoryBlock;
  now: Date;
}): Promise<void> {
  const turnId = ulid().toLowerCase();
  const stamp = (step: number): string => new Date(now.getTime() + step * STEP_MS).toISOString();
  const input: TurnInputItem[] = [{ type: 'user.message', content: briefing.userText }];

  await store.createTurn({
    turn: {
      turn_id: turnId,
      session_id: sessionId,
      first_turn_id: turnId,
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'running' },
      input,
      custom: { persona: null, manual_persona_activation_id: null },
      created_at: now,
      updated_at: now,
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
        context: [{ role: 'user', content: briefing.userText }],
        current_context_usage: null,
      },
    ],
    capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
    tool_call_memos: [],
    task_states: [],
    update_session_title_if_not_exist: briefing.title,
  });

  const appendContext = (context: ContextMessage[]): Promise<void> =>
    store.appendToThreadContext({
      session_id: sessionId,
      turn_id: turnId,
      thread_id: MAIN_THREAD_ID,
      context,
      current_context_usage: null,
      completion: null,
      tool_call_memo: undefined,
      task_state: undefined,
    });

  const created: TurnCreatedEvent = {
    type: EventType.TURN_CREATED,
    id: newEventId(),
    turn_id: turnId,
    previous_turn_id: null,
    input,
    state: { status: 'running' },
    created_at: now.toISOString(),
    thread_id: null,
  };
  const recall: MemoryRecallPersistedEvent = {
    type: 'aman.memory.recall',
    id: newEventId(),
    created_at: stamp(1),
    injected_block: memoryBlock.block,
    stats: {
      items: memoryBlock.includedItems,
      entities: memoryBlock.includedEntities,
      dropped_over_budget: memoryBlock.droppedOverBudget,
      dropped_below_threshold: 0,
      estimated_tokens: memoryBlock.estimatedTokens,
      recall_ms: 4,
      outcome: memoryBlock.includedItems > 0 ? 'ok' : 'empty',
      budget_reason: 'normal',
    },
    sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
  };

  await store.appendToEvents({
    session_id: sessionId,
    turn_id: turnId,
    events: [created, recall],
  });

  const routeCall: ModelMessageEvent = {
    type: EventType.MODEL_MESSAGE,
    id: newEventId(),
    thread_id: MAIN_THREAD_ID,
    created_at: stamp(2),
    content: 'I found your appointment. Let me map the trip.',
    finish_reason: 'tool_calls',
    tool_calls: [
      {
        id: ROUTE_CALL_ID,
        type: 'function',
        function: { name: ROUTE_TOOL_NAME, arguments: JSON.stringify(briefing.routeArguments) },
        tool_info: { type: 'mcp', server_id: MAPS_SERVER_ID, server_name: 'Maps', name: ROUTE_TOOL_NAME },
      },
    ],
  };
  await store.appendToEvents({ session_id: sessionId, turn_id: turnId, events: [routeCall] });
  await appendContext([
    {
      role: 'assistant',
      content: routeCall.content,
      tool_calls: [
        {
          id: ROUTE_CALL_ID,
          type: 'function',
          function: { name: ROUTE_TOOL_NAME, arguments: JSON.stringify(briefing.routeArguments) },
          tool_info: {
            type: 'mcp',
            mcp_server_id: MAPS_SERVER_ID,
            mcp_server_name: 'Maps',
            original_tool_name: ROUTE_TOOL_NAME,
            is_approval_required: true,
          },
        },
      ],
    },
  ]);

  const routeResponse = createToolResponseV2({
    id: newEventId(),
    thread_id: MAIN_THREAD_ID,
    tool_call_id: ROUTE_CALL_ID,
    created_at: stamp(3),
    raw_content: JSON.stringify({ status: 'ok', ...briefing.routeResult }),
    model_content: null,
    screen: null,
    admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    memoized: false,
    repeat_count: 1,
    disposition: 'executed_ok',
    remediation: undefined,
  });
  await store.appendToEvents({ session_id: sessionId, turn_id: turnId, events: [routeResponse.event] });
  await appendContext([routeResponse.model_message]);

  const finalMessage: ModelMessageEvent = {
    type: EventType.MODEL_MESSAGE,
    id: newEventId(),
    thread_id: MAIN_THREAD_ID,
    created_at: stamp(4),
    content: briefing.finalText,
    finish_reason: 'stop',
  };
  await store.appendToEvents({ session_id: sessionId, turn_id: turnId, events: [finalMessage] });
  await appendContext([{ role: 'assistant', content: briefing.finalText }]);

  const state: TerminalTurnState = {
    status: 'done',
    output: finalMessage,
    required_actions: [],
    completed_at: stamp(5),
  };
  await store.updateTurnState({
    session_id: sessionId,
    turn_id: turnId,
    state,
    turn_done_event: {
      type: EventType.TURN_DONE,
      id: newEventId(),
      created_at: stamp(5),
      state,
      thread_id: null,
    },
  });
}
