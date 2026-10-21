/**
 * Seeds finished chats with `aman.model.usage` events, the rows the usage summary reads. Each chat
 * gets one done turn, so its events land in the completed-turn log the way a finished turn's do.
 */
import { newEventId } from '@truefoundry/trueforge-core/core';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTurnDoneEvent,
} from '../../../trueforge-core/tests/agent-session/testHelpers';
import type { SqliteSessionStore } from '../../src/db/sqlite/session-store/SqliteSessionStore';
import { MODEL_USAGE_EVENT_TYPE, type ModelUsagePersistedEvent } from '../../src/schemas/modelUsageEvents';

export function usageEvent({
  createdAt,
  modelId,
  displayName,
  inputTokens,
  outputTokens,
  costUsd,
}: {
  createdAt: string;
  modelId: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}): ModelUsagePersistedEvent {
  return {
    type: MODEL_USAGE_EVENT_TYPE,
    id: newEventId(),
    created_at: createdAt,
    role: 'chat',
    model_name: modelId,
    model_id: modelId,
    display_name: displayName,
    provider: 'tokenfactory',
    calls: 1,
    reported_calls: 1,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
  };
}

/** A finished chat owned by `owner`, titled `title` (null for untitled), with the given usage events. */
export async function seedDoneChat({
  store,
  tenantId,
  sessionId,
  owner,
  title,
  events,
}: {
  store: SqliteSessionStore;
  tenantId: string;
  sessionId: string;
  owner: string;
  title: string | null;
  events: ModelUsagePersistedEvent[];
}): Promise<void> {
  const turnId = `${sessionId}-turn`;
  await store.createSession({
    tenant_id: tenantId,
    session_id: sessionId,
    created_by_subject: { subject_id: owner, subject_type: 'user', subject_display_name: owner },
    external_id: null,
    source: null,
    metadata: {},
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
  });
  if (title !== null) {
    await store.updateSession({
      tenant_id: tenantId,
      session_id: sessionId,
      agent: undefined,
      title,
      metadata: undefined,
    });
  }
  await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
  const state = makeDoneTurnState();
  await store.updateTurnState({
    session_id: sessionId,
    turn_id: turnId,
    state,
    turn_done_event: makeTurnDoneEvent(state),
  });
  await store.appendEventsToDoneTurn({ session_id: sessionId, turn_id: turnId, events });
}
