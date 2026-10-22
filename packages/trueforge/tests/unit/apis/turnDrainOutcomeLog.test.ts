import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/agent-session';
import { Writable } from 'stream';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { GetSessionPersonaInput } from '../../../src/db/personaStore';
import type { PersonaActivation } from '../../../src/personas/persona';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';

const userText = 'Please remember that my houseplant is a cactus named Gerald.';

async function* doneStream(): AsyncGenerator<TurnStreamingEvent> {
  yield {
    type: EventType.TURN_DONE,
    id: 'evt_done',
    created_at: '2026-10-22T12:00:00.000Z',
    state: {
      status: 'done',
      output: {
        type: 'model.message',
        id: 'evt_model_message',
        thread_id: 'main',
        created_at: '2026-10-22T12:00:00.000Z',
        content: 'Noted: Gerald the cactus.',
      },
      required_actions: [],
      completed_at: '2026-10-22T12:00:00.000Z',
    },
    thread_id: null,
  };
}

function captureLogger(): { logger: winston.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.json(),
    transports: [new winston.transports.Stream({ stream })],
  });
  return { logger, lines };
}

function infoEntries(lines: string[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = lines.map(line => JSON.parse(line));
  return entries.filter(entry => entry['level'] === 'info');
}

/** Drains one completed turn with memory wired in; `activePersonaName` is what the chat ends under. */
async function drainTurn(input: { activePersonaName: string | null; interactive: boolean }) {
  const client = new HindsightClient({
    apiBase: 'https://hindsight.test.example',
    bank: 'aman',
    headers: {},
    fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
  });
  jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
  const activation: PersonaActivation = {
    tenant_id: 'tenant-1',
    id: 'activation-1',
    session_id: 's1',
    turn_id: null,
    persona_id: input.activePersonaName === null ? null : 'persona-1',
    persona_name: input.activePersonaName,
    model_name: null,
    source: 'explicit',
    created_at: '2026-10-22T12:00:00.000Z',
  };
  const getSessionPersona = jest.fn(async (_input: GetSessionPersonaInput) => activation);
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  const { logger, lines } = captureLogger();
  await drainTurnEvents({
    trackedStream: doneStream(),
    turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-1'),
    sessionId: 's1',
    turnId: 't1',
    executionDeadline,
    logger,
    turnDrains: new TurnDrainRegistry(),
    memory: {
      client,
      userText,
      sessionTitle: undefined,
      attachedFiles: false,
      outcomeLog: input.interactive
        ? { personaName: 'Gardener', personaStore: { getSessionPersona }, tenantId: 'tenant-1' }
        : undefined,
    },
  });
  return { getSessionPersona, lines };
}

describe('drainTurnEvents outcome log', () => {
  it('logs one info line when the chat ended under a different persona than the turn started with', async () => {
    const { lines } = await drainTurn({ activePersonaName: 'Chef', interactive: true });

    const entries = infoEntries(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'Turn memory saved under the persona the turn started with',
      sessionId: 's1',
      turnId: 't1',
      personaName: 'Gardener',
      activePersonaName: 'Chef',
      reason: 'persona_switched',
    });
    expect(lines.join('\n')).not.toContain('houseplant');
    expect(lines.join('\n')).not.toContain('Gerald');
  });

  it('keeps a turn that ended under its own persona silent at info', async () => {
    const { lines } = await drainTurn({ activePersonaName: 'Gardener', interactive: true });

    expect(infoEntries(lines)).toHaveLength(0);
  });

  it('logs nothing and reads no persona for a scheduled turn', async () => {
    const { getSessionPersona, lines } = await drainTurn({ activePersonaName: 'Chef', interactive: false });

    expect(getSessionPersona).not.toHaveBeenCalled();
    expect(infoEntries(lines)).toHaveLength(0);
  });
});
