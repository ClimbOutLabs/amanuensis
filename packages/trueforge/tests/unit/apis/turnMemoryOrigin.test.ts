import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { MEMORY_ORIGIN_METADATA_KEY } from '../../../src/runtime/memory/memoryOrigin';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';

async function* doneStream(): AsyncGenerator<TurnStreamingEvent> {
  yield {
    type: EventType.TURN_DONE,
    id: 'evt_done',
    created_at: '2026-09-01T12:00:00.000Z',
    state: {
      status: 'done',
      output: {
        type: 'model.message',
        id: 'evt_model_message',
        thread_id: 'main',
        created_at: '2026-09-01T12:00:00.000Z',
        content: 'Noted.',
      },
      required_actions: [],
      completed_at: '2026-09-01T12:00:00.000Z',
    },
    thread_id: null,
  };
}

async function retainedOrigin(input: { attachedFiles: boolean }): Promise<unknown> {
  const client = new HindsightClient({
    apiBase: 'https://hindsight.test.example',
    bank: 'aman',
    headers: {},
    fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
  });
  const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  await drainTurnEvents({
    trackedStream: doneStream(),
    turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-1'),
    sessionId: 's1',
    turnId: 't1',
    executionDeadline,
    logger: winston.createLogger({ silent: true }),
    turnDrains: new TurnDrainRegistry(),
    memory: { client, userText: 'Please read this.', sessionTitle: undefined, attachedFiles: input.attachedFiles },
  });
  const item = retain.mock.calls[0]?.[0].items[0];
  return item?.metadata?.[MEMORY_ORIGIN_METADATA_KEY];
}

describe('drainTurnEvents memory origin', () => {
  it('labels a turn that read an attached file tool_ingested', async () => {
    expect(await retainedOrigin({ attachedFiles: true })).toBe('tool_ingested');
  });

  it('labels a turn with only the user text user_stated', async () => {
    expect(await retainedOrigin({ attachedFiles: false })).toBe('user_stated');
  });
});
