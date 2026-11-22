/**
 * Tracked open items, end to end: the real retain passes with a scripted model, the real
 * markdown store in a temporary folder, and the real recall path that supplies the outstanding
 * list to a brief. Every name, form and address here is invented.
 *
 * The scripted model answers each of the two turn-end passes from a script the test sets per
 * turn, resolving item numbers from the very list the prompt carries, the way a real model
 * would read them.
 */
import type { AgentThreadExecutionContext, ContextMessage, ILLM } from '@truefoundry/trueforge-core/core';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { memoryCapability, type MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { foldItemEvents, parseItemLog, type TrackedItem } from '../../../../src/runtime/memory/memoryItems';
import type { TurnToolResult } from '../../../../src/runtime/memory/memoryNotesSummarize';
import { submitRetain, type SummarizeTurnContext } from '../../../../src/runtime/memory/memoryRetain';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

const BRIEF_TASK = 'Write my morning brief: what is on today, anything overdue, and what I still need to do.';

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

function makeLogger() {
  return winston.createLogger({ silent: true });
}

/** A scripted answer for one pass; it sees the whole prompt, so it can name items by their number in it. */
type Responder = (prompt: string) => string;

const NO_FLAGS: Responder = () => '{"facts": []}';
const NO_NOTES: Responder = () => '{"findings": [], "responses": []}';

const scripted: { person: Responder; notes: Responder } = { person: NO_FLAGS, notes: NO_NOTES };

/** The number the prompt's open-items list gives to the entry whose line holds this text. */
function itemNumber({ prompt, text }: { prompt: string; text: string }): number {
  // The instructions mention the tag too; the list itself is the last block with that name.
  const block = prompt.split('<open_items>').pop()?.split('</open_items>')[0] ?? '';
  for (const line of block.split('\n')) {
    const match = /^(\d+)\./.exec(line.trim());
    if (match?.[1] !== undefined && line.includes(text)) {
      return Number(match[1]);
    }
  }
  throw new Error(`no open item naming "${text}" in the prompt: ${block}`);
}

function scriptedLlm(): ILLM {
  return {
    create: () => {
      throw new Error('streaming is not used');
    },
    createNonStream: body => {
      const messages = body.messages.map(message => (typeof message.content === 'string' ? message.content : ''));
      const prompt = messages.join('\n');
      const reply = prompt.includes('from what an assistant found') ? scripted.notes(prompt) : scripted.person(prompt);
      return Promise.resolve({
        output: { role: 'assistant' as const, content: reply },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop' as const,
      });
    },
  };
}

const CONFIG: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

describe('tracked open items across chats', () => {
  let dir: string;
  let client: MarkdownMemoryClient;
  let settings: ReturnType<typeof inMemoryGlobalSettingsStore>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'memory-items-'));
    client = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant' });
    settings = inMemoryGlobalSettingsStore();
    scripted.person = NO_FLAGS;
    scripted.notes = NO_NOTES;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function summarizeContext(): SummarizeTurnContext {
    return {
      tenantId: 't1',
      modelProviderStore: unusedStore,
      summarizationModelFqn: 'provider/model',
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      globalSettingsStore: settings,
      modelUsage: discardedModelUsage,
      personName: 'Alex',
      resolveLlm: () => Promise.resolve(scriptedLlm()),
    };
  }

  async function submit(turn: {
    sessionId: string;
    id: string;
    userText: string;
    completedAt: string;
    toolResults?: TurnToolResult[];
  }): Promise<void> {
    await submitRetain({
      session: { is_incognito: false },
      client,
      sessionId: turn.sessionId,
      turnId: turn.id,
      userText: turn.userText,
      assistantText: 'Got it.',
      completedAt: turn.completedAt,
      origin: turn.toolResults === undefined ? 'user_stated' : 'tool_ingested',
      logger: makeLogger(),
      ...(turn.toolResults === undefined ? {} : { toolResults: turn.toolResults }),
      summarize: summarizeContext(),
    });
  }

  async function items(): Promise<TrackedItem[]> {
    let content = '';
    try {
      content = await readFile(path.join(dir, 'tenant', 'items.md'), 'utf8');
    } catch {
      content = '';
    }
    return foldItemEvents(parseItemLog(content));
  }

  async function diaryText(): Promise<string> {
    const folder = path.join(dir, 'tenant', 'memory');
    let names: string[] = [];
    try {
      names = await readdir(folder);
    } catch {
      return '';
    }
    const parts: string[] = [];
    for (const name of names.sort()) {
      parts.push(await readFile(path.join(folder, name), 'utf8'));
    }
    return parts.join('\n');
  }

  /** Runs the real recall path for one new chat whose only message is the brief task, and returns its block. */
  async function briefBlock(config: MemoryConfig = CONFIG): Promise<string> {
    const capability = memoryCapability({
      client,
      config,
      logger: makeLogger(),
      sessionId: 'brief-chat',
      previousTurnId: null,
      keepsFullExchange: false,
      timeZone: 'UTC',
    });
    const processor = capability.preLLMProcessors?.[0];
    if (processor === undefined) {
      throw new Error('expected a preLLM processor');
    }
    const context: ContextMessage[] = [{ role: 'user', content: BRIEF_TASK }];
    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: 'main',
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
      context,
    };
    let block: string | undefined;
    for await (const output of processor.processPreLLM(execution)) {
      const candidate: unknown = output;
      if (typeof candidate !== 'object' || candidate === null || !('event' in candidate)) {
        continue;
      }
      const event: unknown = candidate.event;
      if (typeof event !== 'object' || event === null || !('injected_block' in event)) {
        continue;
      }
      if (typeof event.injected_block === 'string') {
        block = event.injected_block;
      }
    }
    // No block at all means recall injected nothing, which the segment assertions read as empty.
    return block ?? '';
  }

  /** The tracked-items segment of a block, or '' when the block carries none. */
  function itemsSegment(block: string): string {
    const start = block.indexOf('<aman-items>');
    const end = block.indexOf('</aman-items>');
    return start === -1 || end === -1 ? '' : block.slice(start, end);
  }

  const FESTIVAL_EMAIL: TurnToolResult = {
    source: 'email',
    text: [
      'From: Harbour Festival Office <office@harbourfest.example>',
      'To: Alex',
      'Subject: Your stall entry form',
      'Dear Alex, please submit the enclosed entry form for your stall by Friday. The form is in the attached pack.',
    ].join('\n'),
  };

  function festivalRequestNotes(): void {
    scripted.notes = () =>
      JSON.stringify({
        findings: [{ result: 1, text: 'Harbour Festival asked Alex to submit the entry form by 2026-11-20.' }],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Submit the harbour festival entry form',
            citation: 'please submit the enclosed entry form for your stall by Friday',
            addressedToPerson: true,
            tiedToRole: true,
            due: '2026-11-20',
          },
        ],
      });
  }

  /** The incident shape: the obligation in one chat, the completion in a second, an unrelated item alongside. */
  async function runIncidentFixture(): Promise<void> {
    festivalRequestNotes();
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the harbour festival?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [FESTIVAL_EMAIL],
    });
    scripted.person = () =>
      JSON.stringify({
        facts: ['The person needs to renew the library card.'],
        items: [
          {
            kind: 'request',
            owner: 'the person',
            action: 'Renew the library card',
            citation: 'I need to renew my library card this week',
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a2',
      userText: 'I need to renew my library card this week.',
      completedAt: '2026-11-16T12:05:00.000Z',
    });
    scripted.person = prompt =>
      JSON.stringify({
        facts: ['The person submitted the harbour festival entry form.'],
        items: [
          {
            kind: 'completion',
            item: itemNumber({ prompt, text: 'harbour festival entry form' }),
            owner: 'the person',
            action: 'Submit the harbour festival entry form',
            citation: 'I submitted the harbour festival entry form this morning',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'I submitted the harbour festival entry form this morning.',
      completedAt: '2026-11-17T12:00:00.000Z',
    });
  }

  it('case 1: a completion in a second chat keeps the item out of the next brief, and the unrelated item appears', async () => {
    await runIncidentFixture();

    const folded = await items();
    expect(folded.filter(item => item.state === 'open').map(item => item.action)).toEqual(['Renew the library card']);
    expect(folded.find(item => item.action.includes('harbour festival'))?.state).toBe('closed');

    const segment = itemsSegment(await briefBlock());
    expect(segment).toContain('Renew the library card');
    expect(segment.toLowerCase()).not.toContain('harbour festival');
  });

  it('case 2: both diary entries are still present afterwards', async () => {
    await runIncidentFixture();

    const diary = await diaryText();
    expect(diary).toContain('Harbour Festival asked Alex to submit the entry form by 2026-11-20.');
    expect(diary).toContain('The person submitted the harbour festival entry form.');
  });

  it('case 3: under a budget that cuts the completion from the diary block, the outstanding list is still correct', async () => {
    await runIncidentFixture();

    const block = await briefBlock({ ...CONFIG, recallMaxTokens: 40 });
    const segment = itemsSegment(block);
    expect(segment).toContain('Renew the library card');
    expect(segment.toLowerCase()).not.toContain('harbour festival');
    // The diary block was cut so hard that the completion's own entry never reached it; the
    // tracked list, which is not budgeted against the diary, is what keeps the brief right.
    expect(block).not.toContain('The person submitted the harbour festival entry form.');
  });

  it('case 4: an unverifiable citation from read content opens nothing, and neither does one naming a third-party owner', async () => {
    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Return the signed lease',
            citation: 'Please return the signed lease by Monday',
            addressedToPerson: true,
            tiedToRole: true,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the harbour festival?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [FESTIVAL_EMAIL],
    });
    expect(await items()).toEqual([]);

    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'Priya Nair',
            action: 'Submit the harbour festival entry form',
            citation: 'please submit the enclosed entry form for your stall by Friday',
            addressedToPerson: true,
            tiedToRole: true,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a2',
      userText: 'Can you read this email from the harbour festival once more?',
      completedAt: '2026-11-16T13:00:00.000Z',
      toolResults: [FESTIVAL_EMAIL],
    });
    expect(await items()).toEqual([]);
    expect(itemsSegment(await briefBlock())).toBe('');
  });

  it('case 5: a filled-in completion against a submit item leaves it open, with the partial work recorded', async () => {
    scripted.person = () =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'request',
            owner: 'the person',
            action: 'Submit the signed lease to the letting agent',
            citation: 'I must submit the signed lease to the letting agent by Friday',
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'I must submit the signed lease to the letting agent by Friday.',
      completedAt: '2026-11-16T12:00:00.000Z',
    });
    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'completion',
            item: itemNumber({ prompt, text: 'signed lease' }),
            owner: 'the person',
            action: 'Fill in the signed lease',
            citation: 'I filled in the signed lease this afternoon',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'I filled in the signed lease this afternoon.',
      completedAt: '2026-11-17T12:00:00.000Z',
    });

    const folded = await items();
    const lease = folded.find(item => item.action.includes('signed lease'));
    expect(lease?.state).toBe('open');
    expect(lease?.partialNotes).toEqual(['Fill in the signed lease']);
    expect(itemsSegment(await briefBlock())).toContain('Partly done: Fill in the signed lease');
  });

  it('case 6: an ambiguous completion closes neither of two similar items and is recorded unconfirmed; a named one closes exactly one', async () => {
    scripted.person = () =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'request',
            owner: 'the person',
            action: 'Submit the harbour festival entry form',
            citation: 'I need to submit the entry form for the harbour festival',
          },
          {
            kind: 'request',
            owner: 'the person',
            action: 'Submit the harbour festival stall fee form',
            citation: 'I need to submit the stall fee form for the harbour festival',
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText:
        'I need to submit the entry form for the harbour festival. I need to submit the stall fee form for the harbour festival too.',
      completedAt: '2026-11-16T12:00:00.000Z',
    });
    expect((await items()).filter(item => item.state === 'open')).toHaveLength(2);

    scripted.person = () =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'completion',
            owner: 'the person',
            action: 'Submit the harbour festival form',
            citation: 'The harbour festival form went in today',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'The harbour festival form went in today.',
      completedAt: '2026-11-17T12:00:00.000Z',
    });
    let folded = await items();
    expect(folded.filter(item => item.state === 'open')).toHaveLength(2);
    expect(folded.every(item => item.unconfirmedCompletions.length === 1)).toBe(true);

    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'completion',
            item: itemNumber({ prompt, text: 'entry form' }),
            owner: 'the person',
            action: 'Submit the harbour festival entry form',
            citation: 'I submitted the entry form this morning',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b2',
      userText: 'I submitted the entry form this morning.',
      completedAt: '2026-11-17T13:00:00.000Z',
    });
    folded = await items();
    expect(folded.find(item => item.action.includes('entry form'))?.state).toBe('closed');
    expect(folded.find(item => item.action.includes('stall fee form'))?.state).toBe('open');
  });

  it('case 7: the corrections bind to the one item they name', async () => {
    // An open item from the person's own words, and a below-bar item from mail that only surfaced.
    scripted.person = () =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'request',
            owner: 'the person',
            action: 'Post the council tax form',
            citation: 'I still need to post the council tax form',
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'I still need to post the council tax form.',
      completedAt: '2026-11-16T12:00:00.000Z',
    });
    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Renew the allotment waiting list place',
            citation: 'Places on the waiting list can be renewed at the allotment office',
            addressedToPerson: false,
            tiedToRole: false,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a2',
      userText: 'Can you read this notice from the allotment association?',
      completedAt: '2026-11-16T12:30:00.000Z',
      toolResults: [
        {
          source: 'email',
          text: 'From: Allotment Association <news@allotments.example>\nSubject: Waiting list\nPlaces on the waiting list can be renewed at the allotment office.',
        },
      ],
    });
    let folded = await items();
    expect(folded.find(item => item.action.includes('council tax'))?.state).toBe('open');
    expect(folded.find(item => item.action.includes('allotment'))?.state).toBe('surfaced');

    // "Already sent" closes on the person's word, with no citation beyond their own sentence.
    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'correction',
            item: itemNumber({ prompt, text: 'council tax form' }),
            correction: 'already_done',
            owner: 'the person',
            action: 'Post the council tax form',
            citation: 'I already sent the council tax form yesterday',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'I already sent the council tax form yesterday.',
      completedAt: '2026-11-17T12:00:00.000Z',
    });
    folded = await items();
    const council = folded.find(item => item.action.includes('council tax'));
    expect(council?.state).toBe('closed');
    expect(council?.closeReason).toBe('completed');

    // "That's mine" starts a surfaced item tracking.
    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'correction',
            item: itemNumber({ prompt, text: 'allotment' }),
            correction: 'mine',
            owner: 'the person',
            action: 'Renew the allotment waiting list place',
            citation: 'the allotment waiting list place is mine',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b2',
      userText: 'Actually, the allotment waiting list place is mine, I do need to renew it.',
      completedAt: '2026-11-17T12:30:00.000Z',
    });
    folded = await items();
    expect(folded.find(item => item.action.includes('allotment'))?.state).toBe('open');
    expect(itemsSegment(await briefBlock())).toContain('Renew the allotment waiting list place');
  });

  it('case 7b: "that was Stephanie\'s" closes an item as not theirs, and it never resurfaces', async () => {
    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Book the dentist appointment',
            citation: 'Please book the dentist appointment for Stephanie this week',
            addressedToPerson: true,
            tiedToRole: true,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the surgery?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [
        {
          source: 'email',
          text: 'From: Dental Surgery <care@dentalsurgery.example>\nTo: Alex\nSubject: Appointment\nPlease book the dentist appointment for Stephanie this week.',
        },
      ],
    });
    expect((await items()).find(item => item.action.includes('dentist'))?.state).toBe('open');

    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'correction',
            item: itemNumber({ prompt, text: 'dentist appointment' }),
            correction: 'not_theirs',
            owner: 'the person',
            action: 'Book the dentist appointment',
            citation: 'That dentist appointment was Stephanie\u2019s, not mine',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'That dentist appointment was Stephanie\u2019s, not mine.',
      completedAt: '2026-11-17T12:00:00.000Z',
    });
    const folded = await items();
    const dentist = folded.find(item => item.action.includes('dentist'));
    expect(dentist?.state).toBe('closed');
    expect(dentist?.closeReason).toBe('not_theirs');
    expect(itemsSegment(await briefBlock())).toBe('');
  });

  it('case 8: the same email twice, once forwarded, opens one item; it is supplied as overdue; "drop it" closes it', async () => {
    const permitEmail: TurnToolResult = {
      source: 'email',
      text: [
        'From: Market Office <permits@marketoffice.example>',
        'To: Alex',
        'Subject: Stall permit renewal',
        'Dear Alex, please return the signed stall permit renewal form by 1 June 2020.',
      ].join('\n'),
    };
    const permitNotes = (): void => {
      scripted.notes = () =>
        JSON.stringify({
          findings: [],
          responses: [],
          items: [
            {
              kind: 'request',
              result: 1,
              owner: 'the person',
              action: 'Return the signed stall permit renewal form',
              citation: 'please return the signed stall permit renewal form by 1 June 2020',
              addressedToPerson: true,
              tiedToRole: true,
              due: '2020-06-01',
            },
          ],
        });
    };
    permitNotes();
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the market office?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [permitEmail],
    });
    permitNotes();
    await submit({
      sessionId: 'chat-b',
      id: 'b1',
      userText: 'Can you read this forwarded email?',
      completedAt: '2026-11-17T12:00:00.000Z',
      toolResults: [
        {
          source: 'email',
          text: `Forwarded message:\n${permitEmail.text}`,
        },
      ],
    });

    let folded = await items();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.state).toBe('open');
    expect(folded[0]?.evidenceCount).toBe(1);

    const segment = itemsSegment(await briefBlock());
    expect(segment).toContain('Return the signed stall permit renewal form');
    expect(segment).toContain('Due 2020-06-01, which has passed.');

    scripted.person = prompt =>
      JSON.stringify({
        facts: [],
        items: [
          {
            kind: 'correction',
            item: itemNumber({ prompt, text: 'stall permit' }),
            correction: 'drop',
            owner: 'the person',
            action: 'Return the signed stall permit renewal form',
            citation: 'Just drop it',
          },
        ],
      });
    await submit({
      sessionId: 'chat-b',
      id: 'b2',
      userText: 'Just drop it, I am not doing that form.',
      completedAt: '2026-11-17T13:00:00.000Z',
    });
    folded = await items();
    expect(folded[0]?.state).toBe('closed');
    expect(folded[0]?.closeReason).toBe('dropped');
    expect(itemsSegment(await briefBlock())).toBe('');
  });

  it('zero case: a personalized subscribe promotion opens nothing', async () => {
    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Subscribe to the harbour newsletter',
            citation: 'Alex, subscribe today and save 10% on harbour gifts',
            addressedToPerson: true,
            tiedToRole: false,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [
        {
          source: 'email',
          text: [
            'From: Harbour Gifts <offers@harbourgifts.example>',
            'To: Alex',
            'List-Unsubscribe: <https://harbourgifts.example/leave>',
            'Subject: 10% off, just for you',
            'Alex, subscribe today and save 10% on harbour gifts. This offer ends soon.',
          ].join('\n'),
        },
      ],
    });
    expect(await items()).toEqual([]);
    expect(itemsSegment(await briefBlock())).toBe('');
  });

  it('zero case: a "contact Stephanie" inside a document the person asked to summarize opens nothing', async () => {
    scripted.notes = () =>
      JSON.stringify({
        findings: [],
        responses: [],
        items: [
          {
            kind: 'request',
            result: 1,
            owner: 'the person',
            action: 'Contact Stephanie about the hall booking',
            citation: 'Please contact Stephanie about the hall booking',
            addressedToPerson: false,
            tiedToRole: false,
          },
        ],
      });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Summarize this document for me.',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [
        {
          source: 'attachment',
          text: 'Village Hall Committee, notes of the autumn meeting. The roof fund stands at 400 pounds. Please contact Stephanie about the hall booking before the spring term.',
        },
      ],
    });
    const folded = await items();
    expect(folded.filter(item => item.state === 'open')).toEqual([]);
    expect(itemsSegment(await briefBlock())).toBe('');
  });

  it('a school consent form in bulk mail opens when the model answers in the shape the prompt teaches', async () => {
    scripted.notes = prompt => {
      // The reply copies the item shape from the prompt's own example, whichever field names
      // the instructions use, the way a real model following the prompt would.
      const request = {
        kind: 'request',
        result: 1,
        owner: 'the person',
        action: 'Return the signed consent form for your child',
        citation: 'please return the signed consent form for your child by Friday',
        due: '2026-11-20',
      };
      const item = prompt.includes('"addressedToPerson"')
        ? { ...request, addressedToPerson: true, tiedToRole: true }
        : { ...request, addressed: true, tied: true };
      return JSON.stringify({ findings: [], responses: [], items: [item] });
    };
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the school?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [
        {
          source: 'email',
          text: [
            'From: School Office <office@springfieldschool.example>',
            'To: Alex',
            'List-Unsubscribe: <https://springfieldschool.example/leave>',
            'Subject: Consent form for the school trip',
            'Dear parent, please return the signed consent form for your child by Friday so your child can join the school trip.',
          ].join('\n'),
        },
      ],
    });
    const folded = await items();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.state).toBe('open');
    expect(folded[0]?.action).toBe('Return the signed consent form for your child');
    expect(itemsSegment(await briefBlock())).toContain('Return the signed consent form for your child');
  });

  it('the same request flagged by both passes of one turn opens one item, not two', async () => {
    const flag = {
      kind: 'request',
      owner: 'the person',
      action: 'Submit the harbour festival entry form',
      citation: 'I need to submit the harbour festival entry form on Friday',
    };
    scripted.person = () => JSON.stringify({ facts: [], items: [flag] });
    scripted.notes = () => JSON.stringify({ findings: [], responses: [], items: [flag] });
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'I need to submit the harbour festival entry form on Friday.',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [FESTIVAL_EMAIL],
    });
    const folded = await items();
    expect(folded).toHaveLength(1);
    expect(folded[0]?.state).toBe('open');
    expect(folded[0]?.action).toBe('Submit the harbour festival entry form');
  });

  it('the off switch: with tracking off, a turn records no items and recall supplies none', async () => {
    settings = inMemoryGlobalSettingsStore({ memory_item_tracking_enabled: 'false' });
    festivalRequestNotes();
    await submit({
      sessionId: 'chat-a',
      id: 'a1',
      userText: 'Can you read this email from the harbour festival?',
      completedAt: '2026-11-16T12:00:00.000Z',
      toolResults: [FESTIVAL_EMAIL],
    });
    expect(await items()).toEqual([]);
    // The diary still holds the finding: switching tracking off never touches the diary.
    expect(await diaryText()).toContain('Harbour Festival asked Alex to submit the entry form by 2026-11-20.');
  });
});
