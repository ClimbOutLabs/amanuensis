/**
 * What a turn hands to the note pass: a result read out of the stored memory pages is memory itself,
 * not a finding of the turn that read it, so it must never reach the pass, while a result the turn
 * genuinely read from outside still does. The turn is still marked as one that read outside content
 * either way; only the note pass is kept from storing the memory again.
 */
import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { drainTurnEvents } from '../../../src/apis/turns';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import { type RetainItem } from '../../../src/runtime/memory/memoryClient';
import { NOTE_SOURCE_METADATA_KEY } from '../../../src/runtime/memory/memoryNotes';
import type { TurnToolResult } from '../../../src/runtime/memory/memoryNotesSummarize';
import { MEMORY_ORIGIN_METADATA_KEY } from '../../../src/runtime/memory/memoryOrigin';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../fixtures/inMemoryGlobalSettingsStore';
import { QuietMemoryClient } from '../../fixtures/memory/quietMemoryClient';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const NOW = '2026-09-01T12:00:00.000Z';

/** Every set of results the note pass was handed, one entry per call. */
const mockNotePassResults: TurnToolResult[][] = [];

jest.mock('../../../src/runtime/memory/memoryNotesSummarize', () => {
  const actual = jest.requireActual<typeof import('../../../src/runtime/memory/memoryNotesSummarize')>(
    '../../../src/runtime/memory/memoryNotesSummarize',
  );
  return {
    ...actual,
    summarizeTurnNotes: jest.fn(params => {
      mockNotePassResults.push(params.results);
      const [first] = params.results;
      return Promise.resolve(
        first === undefined ? [] : [{ source: first.source, text: 'A finding taken from the first result.' }],
      );
    }),
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

/** The model asks for one tool and the tool answers, as the turn stream carries them. */
function toolRound({
  id,
  name,
  args = '{}',
  result = '{"ok": true}',
}: {
  id: string;
  name: string;
  args?: string;
  result?: string;
}): TurnStreamingEvent[] {
  return [
    {
      type: EventType.MODEL_MESSAGE,
      id: `evt_call_${id}`,
      thread_id: 'main',
      created_at: NOW,
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name, arguments: args },
          tool_info: { type: 'truefoundry-system', name },
        },
      ],
    },
    {
      type: EventType.TOOL_RESPONSE_V2,
      id: `evt_response_${id}`,
      thread_id: 'main',
      created_at: NOW,
      tool_call_id: id,
      content: result,
      disposition: 'executed_ok',
      admission_provenance: { source: 'internal' },
    },
  ];
}

async function* doneStream(earlier: TurnStreamingEvent[]): AsyncGenerator<TurnStreamingEvent> {
  yield* earlier;
  yield {
    type: EventType.TURN_DONE,
    id: 'evt_done',
    created_at: NOW,
    state: {
      status: 'done',
      output: {
        type: 'model.message',
        id: 'evt_model_message',
        thread_id: 'main',
        created_at: NOW,
        content: 'Noted.',
      },
      required_actions: [],
      completed_at: NOW,
    },
    thread_id: null,
  };
}

/** Drain one turn that read the given tool rounds, and return what it retained. */
async function retainedItems(earlier: TurnStreamingEvent[]): Promise<RetainItem[]> {
  const client = new QuietMemoryClient();
  const retain = jest.spyOn(client, 'retain').mockResolvedValue({ ok: true });
  jest.spyOn(client, 'getOperation').mockResolvedValue({ ok: true, status: 'completed' });
  const executionDeadline = new TurnExecutionDeadline({
    abortController: new AbortController(),
    default_timeout_ms: 60_000,
    finalization_buffer_ms: 1_000,
  });
  executionDeadline.arm();
  await drainTurnEvents({
    trackedStream: doneStream(earlier),
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

const MEMORY_PAGE = '# Allotment\n\n## Now\n- The shed key hangs by the back door.';
const MAIL_TEXT = 'From: Priya. Subject: Form. Please send the signed form by 3 November.';

function wrappedPageRead(result: string): TurnStreamingEvent[] {
  return toolRound({
    id: 'c1',
    name: 'call_tool',
    args: JSON.stringify({ mcp_server: 'memory_pages', tool_name: 'read_page', input: {} }),
    result,
  });
}

function noteItems(items: readonly RetainItem[]): RetainItem[] {
  return items.filter(item => item.metadata[NOTE_SOURCE_METADATA_KEY] !== undefined);
}

describe('drainTurnEvents and the note pass', () => {
  beforeEach(() => {
    mockNotePassResults.length = 0;
  });

  it('never hands a result read out of the memory pages to the note pass, and stores no note from it', async () => {
    const items = await retainedItems(wrappedPageRead(MEMORY_PAGE));
    expect(mockNotePassResults.length).toBeGreaterThan(0);
    for (const results of mockNotePassResults) {
      expect(results).toEqual([]);
    }
    expect(noteItems(items)).toEqual([]);
  });

  it('still marks the turn as one that read outside content, so its own words keep the strict stamp', async () => {
    const items = await retainedItems(wrappedPageRead(MEMORY_PAGE));
    const [person] = items.filter(item => item.metadata[NOTE_SOURCE_METADATA_KEY] === undefined);
    expect(person?.content).toBe('My dentist is Dr Okafor.');
    expect(person?.metadata[MEMORY_ORIGIN_METADATA_KEY]).toBe('tool_ingested');
  });

  it('hands a mail result to the note pass and stores its note', async () => {
    const items = await retainedItems(toolRound({ id: 'c1', name: 'gmail__read_email', result: MAIL_TEXT }));
    for (const results of mockNotePassResults) {
      expect(results).toEqual([{ source: 'email', text: MAIL_TEXT }]);
    }
    expect(noteItems(items).map(item => item.metadata[NOTE_SOURCE_METADATA_KEY])).toEqual(['email']);
  });

  it('hands over only the outside result when a turn read both mail and a memory page', async () => {
    const earlier = [
      ...wrappedPageRead(MEMORY_PAGE),
      ...toolRound({ id: 'c2', name: 'gmail__read_email', result: MAIL_TEXT }),
    ];
    const items = await retainedItems(earlier);
    for (const results of mockNotePassResults) {
      expect(results).toEqual([{ source: 'email', text: MAIL_TEXT }]);
    }
    expect(noteItems(items).map(item => item.metadata[NOTE_SOURCE_METADATA_KEY])).toEqual(['email']);
  });
});
