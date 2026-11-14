import {
  CancellationReason,
  EventType,
  type TurnDoneEvent,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';

import { drainTurnEvents } from '../../../src/apis/turns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';

const COMPLETED_AT = '2026-11-03T07:04:05.000Z';

function finished(state: TurnDoneEvent['state']): TurnDoneEvent {
  return {
    type: EventType.TURN_DONE,
    id: 'evt_done_finished_answer',
    created_at: COMPLETED_AT,
    state,
    thread_id: null,
  };
}

async function drain(event: TurnDoneEvent): Promise<string[]> {
  async function* stream(): AsyncGenerator<TurnDoneEvent> {
    yield event;
  }
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  const answers: string[] = [];
  await drainTurnEvents({
    trackedStream: stream(),
    turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-finished-answer'),
    sessionId: 'chat-finished-answer',
    turnId: 'turn-finished-answer',
    executionDeadline,
    logger: winston.createLogger({ silent: true }),
    turnDrains: new TurnDrainRegistry(),
    onFinishedAnswer: answer => {
      answers.push(answer);
      return Promise.resolve();
    },
  });
  return answers;
}

describe('the finished answer hook', () => {
  it('is given the answer text once the turn is done', async () => {
    const answers = await drain(
      finished({
        status: 'done',
        output: {
          type: 'model.message',
          id: 'evt_model_message_finished_answer',
          thread_id: 'main',
          created_at: COMPLETED_AT,
          content: 'Two things need you today.',
        },
        required_actions: [],
        completed_at: COMPLETED_AT,
      }),
    );

    expect(answers).toEqual(['Two things need you today.']);
  });

  it('is not called for a turn that failed', async () => {
    const answers = await drain(
      finished({ status: 'error', message: 'The model could not be reached.', completed_at: COMPLETED_AT }),
    );

    expect(answers).toEqual([]);
  });

  it('is not called for a turn that was stopped', async () => {
    const answers = await drain(
      finished({ status: 'cancelled', reason: CancellationReason.ClientCancelled, completed_at: COMPLETED_AT }),
    );

    expect(answers).toEqual([]);
  });
});
