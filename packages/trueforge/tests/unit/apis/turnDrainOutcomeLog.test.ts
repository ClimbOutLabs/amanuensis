import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/agent-session';
import { Writable } from 'stream';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import type { GetSessionPersonaInput } from '../../../src/db/personaStore';
import type { PersonaActivation } from '../../../src/personas/persona';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { HindsightClient } from '../../../src/runtime/memory/hindsightClient';
import { summarizeTurnContent } from '../../../src/runtime/memory/memorySummarize';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

jest.mock('../../../src/runtime/memory/memorySummarize', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/memory/memorySummarize')>(
    '../../../src/runtime/memory/memorySummarize',
  );
  return { ...actual, summarizeTurnContent: jest.fn() };
});

const mockSummarize = jest.mocked(summarizeTurnContent);

const userText = 'Please remember that my houseplant is a cactus named Gerald.';

/** Summarizing to an ability note leaves nothing to store once the note is stripped. */
const abilityNoteSummary = "I can't read email right now.";

/** Summarization context that is only ever read by the mocked summarizer. */
function summarizeContext() {
  const modelProviderStore: IModelProviderStore = {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
  return {
    tenantId: 'tenant-1',
    modelProviderStore,
    summarizationModelFqn: 'openai/gpt-4o',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
  };
}

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

/**
 * Drains one completed turn with memory wired in; `activePersonaName` is what the chat ends under.
 * `retainFails` makes both the submission and its verification pass fail; `abilityNotesOnly`
 * summarizes the turn to an ability note, so nothing is stored.
 */
async function drainTurn(input: {
  activePersonaName: string | null;
  interactive: boolean;
  retainFails?: boolean;
  abilityNotesOnly?: boolean;
}) {
  const client = new HindsightClient({
    apiBase: 'https://hindsight.test.example',
    bank: 'aman',
    headers: {},
    fetchImpl: () => Promise.reject(new Error('drain tests must not reach the network')),
  });
  const retain = jest
    .spyOn(client, 'retain')
    .mockResolvedValue(input.retainFails ? { ok: false, reason: 'provider unreachable' } : { ok: true });
  jest
    .spyOn(client, 'getOperation')
    .mockResolvedValue(
      input.retainFails ? { ok: false, reason: 'provider unreachable' } : { ok: true, status: 'completed' },
    );
  if (input.abilityNotesOnly === true) {
    mockSummarize.mockResolvedValue({ status: 'summarized', summary: abilityNoteSummary });
  }
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
      summarize: input.abilityNotesOnly === true ? summarizeContext() : undefined,
      outcomeLog: input.interactive
        ? { personaName: 'Gardener', personaStore: { getSessionPersona }, tenantId: 'tenant-1' }
        : undefined,
    },
  });
  return { getSessionPersona, lines, retain };
}

describe('drainTurnEvents outcome log', () => {
  beforeEach(() => {
    mockSummarize.mockReset();
  });

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

  it('does not claim a save for an ability-notes-only turn that switched persona; the reason line covers it', async () => {
    const { lines, retain } = await drainTurn({
      activePersonaName: 'Chef',
      interactive: true,
      abilityNotesOnly: true,
    });

    expect(retain).not.toHaveBeenCalled();
    const entries = infoEntries(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: 'Turn memory not saved: it only described what Aman could not do',
      reason: 'ability_notes_only',
    });
    expect(lines.join('\n')).not.toContain('Turn memory saved under the persona');
  });

  it('does not claim a save when the retain fails and the chat switched persona', async () => {
    const { lines } = await drainTurn({
      activePersonaName: 'Chef',
      interactive: true,
      retainFails: true,
    });

    expect(infoEntries(lines).map(entry => entry['message'])).not.toContain(
      'Turn memory saved under the persona the turn started with',
    );
    expect(lines.join('\n')).not.toContain('Turn memory saved under the persona');
  });
});
