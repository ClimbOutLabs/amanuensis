import {
  AgentSpecSchema,
  EventType,
  InMemorySessionStore,
  LATEST_ANSWER_AT_METADATA_KEY,
  type TurnDoneEvent,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import winston from 'winston';

import { drainTurnEvents } from '../../../src/apis/turns';
import type { SessionCustom, TurnCustom } from '../../../src/db/sessionCustom';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';

const TENANT = 'default';
const SESSION_ID = 'chat-answer-drain';
const COMPLETED_AT = '2026-11-03T15:04:05.000Z';

function doneEvent(output: ModelMessageEvent | null): TurnDoneEvent {
  return {
    type: EventType.TURN_DONE,
    id: 'evt_done_answer_mark',
    created_at: COMPLETED_AT,
    state: { status: 'done', output, required_actions: [], completed_at: COMPLETED_AT },
    thread_id: null,
  };
}

async function drainOneTurn(event: TurnDoneEvent) {
  const sessionStore = new InMemorySessionStore<SessionCustom, TurnCustom>();
  await sessionStore.createSession({
    tenant_id: TENANT,
    session_id: SESSION_ID,
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    },
    created_by_subject: { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' },
    external_id: null,
    metadata: { folder_hint: 'keep' },
    source: null,
    is_incognito: false,
    private_expires_at: null,
    custom: null,
  });

  async function* stream(): AsyncGenerator<TurnDoneEvent> {
    yield event;
  }

  const registry = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();

  await drainTurnEvents({
    trackedStream: stream(),
    turnEventStream: registry.get('stream-answer-mark'),
    sessionId: SESSION_ID,
    turnId: 'turn-answer-mark',
    executionDeadline,
    logger: winston.createLogger({ silent: true }),
    turnDrains: new TurnDrainRegistry(),
    answerMark: { sessionStore, tenantId: TENANT },
  });

  return sessionStore.getSession({ tenant_id: TENANT, session_id: SESSION_ID });
}

describe('the finished turn answer stamp', () => {
  it('stamps the chat with the time a turn finished with a final message', async () => {
    const record = await drainOneTurn(
      doneEvent({
        type: 'model.message',
        id: 'evt_model_message_answer_mark',
        thread_id: 'main',
        created_at: COMPLETED_AT,
        content: 'Here is the answer.',
      }),
    );

    expect(record?.metadata).toEqual({ folder_hint: 'keep', [LATEST_ANSWER_AT_METADATA_KEY]: COMPLETED_AT });
  });

  it('stamps nothing when the turn ended paused with no final message', async () => {
    const record = await drainOneTurn(doneEvent(null));

    expect(record?.metadata).toEqual({ folder_hint: 'keep' });
  });
});
