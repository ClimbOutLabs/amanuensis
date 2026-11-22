/**
 * A turn that read a memory page and then said the recalled fact back in a substantive reply: the
 * reply sentence that only repeats the page must not be stored as a fresh note from the reply, while
 * a sentence that adds something new of the reply's own still is. The note pass runs for real here,
 * with a scripted model, so the drop is seen where the turn's memory is decided.
 */
import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { type RetainItem } from '../../../src/runtime/memory/memoryClient';
import { NOTE_SOURCE_METADATA_KEY } from '../../../src/runtime/memory/memoryNotes';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';
import { QuietMemoryClient } from '../../fixtures/memory/quietMemoryClient';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const NOW = '2026-09-01T12:00:00.000Z';

/** The note pass model's next answer, set by each test. */
const scripted = { notes: '{"findings": [], "responses": []}' };

function scriptedNotesLlm() {
  return () =>
    Promise.resolve({
      create: () => {
        throw new Error('streaming is not used');
      },
      createNonStream: () =>
        Promise.resolve({
          output: { role: 'assistant' as const, content: scripted.notes },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop' as const,
        }),
    });
}

/** The real note pass, with its model scripted; the drain's own seam does not reach it. */
jest.mock('../../../src/runtime/memory/memoryNotesSummarize', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/memory/memoryNotesSummarize')>(
    '../../../src/runtime/memory/memoryNotesSummarize',
  );
  return {
    ...actual,
    summarizeTurnNotes: jest.fn(params => actual.summarizeTurnNotes({ ...params, resolveLlm: scriptedNotesLlm() })),
  };
});

const unusedStore: IModelProviderStore = {
  managedElsewhere: false,
  listProviders: jest.fn(),
  getProvider: jest.fn(),
  getProviderForUpdate: jest.fn(),
  createProvider: jest.fn(),
  upsertProvider: jest.fn(),
  recordProviderCheck: jest.fn(async () => undefined),
  listModels: jest.fn(),
  deleteProvider: jest.fn(),
};

/** The person's own summary call, scripted to keep the one fact the person stated. */
function scriptedPersonLlm() {
  return () =>
    Promise.resolve({
      create: () => {
        throw new Error('streaming is not used');
      },
      createNonStream: () =>
        Promise.resolve({
          output: { role: 'assistant' as const, content: '{"facts": ["My dentist is Dr Okafor."]}' },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop' as const,
        }),
    });
}

const MEMORY_PAGE = '# Allotment\n\n## Now\n- The shed key hangs by the back door.';
const RESTATED = 'The shed key hangs by the back door.';
const NEW_STATEMENT =
  'Since Tom waters the beds on Tuesdays, leave the hose where he can reach it without the key, so a locked shed never leaves the beds dry.';
const REPLY = `${RESTATED} ${NEW_STATEMENT}`;

/** The turn: one wrapped read of a memory page, then the reply, as the turn stream carries them. */
function pageReadThenReply(reply: string): TurnStreamingEvent[] {
  return [
    {
      type: EventType.MODEL_MESSAGE,
      id: 'evt_call_c1',
      thread_id: 'main',
      created_at: NOW,
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'call_tool',
            arguments: JSON.stringify({ mcp_server: 'memory_pages', tool_name: 'read_page', input: {} }),
          },
          tool_info: { type: 'truefoundry-system', name: 'call_tool' },
        },
      ],
    },
    {
      type: EventType.TOOL_RESPONSE_V2,
      id: 'evt_response_c1',
      thread_id: 'main',
      created_at: NOW,
      tool_call_id: 'c1',
      content: MEMORY_PAGE,
      disposition: 'executed_ok',
      admission_provenance: { source: 'internal' },
    },
    {
      type: EventType.TURN_DONE,
      id: 'evt_done',
      created_at: NOW,
      state: {
        status: 'done',
        output: { type: 'model.message', id: 'evt_model_message', thread_id: 'main', created_at: NOW, content: reply },
        required_actions: [],
        completed_at: NOW,
      },
      thread_id: null,
    },
  ];
}

/** Drain one turn that read a memory page and replied, and return what it retained. */
async function retainedItems(reply: string): Promise<RetainItem[]> {
  const client = new QuietMemoryClient();
  const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  async function* stream(): AsyncGenerator<TurnStreamingEvent> {
    yield* pageReadThenReply(reply);
  }
  await drainTurnEvents({
    trackedStream: stream(),
    turnEventStream: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined).get('stream-1'),
    sessionId: 's1',
    turnId: 't1',
    executionDeadline,
    logger: winston.createLogger({ silent: true }),
    turnDrains: new TurnDrainRegistry(),
    memory: {
      session: { is_incognito: false },
      client,
      userText: 'My dentist is Dr Okafor.',
      attachedFiles: false,
      summarize: {
        tenantId: 't1',
        modelProviderStore: unusedStore,
        summarizationModelFqn: 'provider/model',
        tokenFactoryBudget: uncappedTokenFactoryBudget,
        globalSettingsStore: inMemoryGlobalSettingsStore(),
        modelUsage: discardedModelUsage,
        resolveLlm: scriptedPersonLlm(),
      },
    },
  });
  return retain.mock.calls.flatMap(([params]) => params.items);
}

function replyNoteItems(items: readonly RetainItem[]): RetainItem[] {
  return items.filter(item => item.metadata[NOTE_SOURCE_METADATA_KEY] === 'assistant_response');
}

describe('a turn that says back what it read from its memory pages', () => {
  beforeEach(() => {
    scripted.notes = '{"findings": [], "responses": []}';
  });

  it('stores no reply note for the sentence that only repeats the recalled fact', async () => {
    scripted.notes = '{"findings": [], "responses": [1]}';
    const items = await retainedItems(REPLY);
    expect(REPLY.length).toBeGreaterThan(120);
    expect(replyNoteItems(items)).toEqual([]);
    // The turn itself was still saved: the person's own fact is there.
    expect(items.some(item => item.content === 'My dentist is Dr Okafor.')).toBe(true);
  });

  it('still stores the new statement the same reply adds', async () => {
    scripted.notes = '{"findings": [], "responses": [1, 2]}';
    const items = await retainedItems(REPLY);
    const notes = replyNoteItems(items);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain(NEW_STATEMENT);
    expect(notes[0]?.content).not.toContain(RESTATED);
  });
});
