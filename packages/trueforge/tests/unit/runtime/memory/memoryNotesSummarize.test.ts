import type { ILLM } from '@truefoundry/trueforge-core/core';
import winston from 'winston';
import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import {
  buildNotesMessages,
  parseNotesReply,
  summarizeTurnNotes,
  type TurnToolResult,
} from '../../../../src/runtime/memory/memoryNotesSummarize';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

const EMAIL: TurnToolResult = {
  source: 'email',
  text: 'From: Priya. Subject: Form. Please send the signed form by 3 November.',
};

const LONG_REPLY =
  'I found one email from Priya. She needs the signed form by 3 November. I would leave by 08:55 for the GP visit so that parking is not a rush.';

function scriptedLlm(reply: string): { llm: ILLM; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    llm: {
      create: () => {
        throw new Error('streaming is not used');
      },
      createNonStream: async () => {
        calls += 1;
        return {
          output: { role: 'assistant' as const, content: reply },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop' as const,
        };
      },
    },
  };
}

const unusedStore: IModelProviderStore = {
  listProviders: jest.fn(),
  getProvider: jest.fn(),
  getProviderForUpdate: jest.fn(),
  createProvider: jest.fn(),
  upsertProvider: jest.fn(),
  listModels: jest.fn(),
  deleteProvider: jest.fn(),
};

function run(overrides: { results: TurnToolResult[]; assistantText: string; llm: ILLM }) {
  return summarizeTurnNotes({
    results: overrides.results,
    assistantText: overrides.assistantText,
    turnDate: '2026-10-29T12:00:00.000Z',
    tenantId: 't1',
    modelProviderStore: unusedStore,
    summarizationModelFqn: 'provider/model',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    modelUsage: discardedModelUsage,
    logger: winston.createLogger({ silent: true }),
    resolveLlm: () => Promise.resolve(overrides.llm),
  });
}

describe('parseNotesReply', () => {
  it('keeps a finding tied to a real result and labels its source from that result', () => {
    const notes = parseNotesReply({
      reply: JSON.stringify({
        findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
        responses: [],
      }),
      results: [EMAIL],
      assistantText: '',
      personName: undefined,
    });
    expect(notes).toEqual([{ source: 'email', text: 'Priya asked for the signed form by 2026-11-03.' }]);
  });

  it('drops a finding that points at no result or says things the result never said', () => {
    const notes = parseNotesReply({
      reply: JSON.stringify({
        findings: [
          { result: 4, text: 'Priya asked for the signed form.' },
          { result: 1, text: 'Zoltan owns a boat called Marigold in Lisbon.' },
        ],
        responses: [],
      }),
      results: [EMAIL],
      assistantText: '',
      personName: undefined,
    });
    expect(notes).toEqual([]);
  });

  it('keeps advice from the reply but never a work plan, task step or progress report', () => {
    const notes = parseNotesReply({
      reply: JSON.stringify({
        findings: [{ result: 1, text: "I'll send the signed form to Priya by 3 November." }],
        responses: [
          'Leave by 08:55 for the GP visit.',
          "I'll make two more edits to the form for Priya.",
          'Next I will search for the GP visit parking.',
          "I've updated the GP visit form.",
        ],
      }),
      results: [EMAIL],
      assistantText: LONG_REPLY,
      personName: undefined,
    });
    expect(notes).toEqual([{ source: 'assistant_response', text: 'Leave by 08:55 for the GP visit.' }]);
  });

  it('treats an unreadable reply as no notes', () => {
    expect(
      parseNotesReply({ reply: 'nothing here', results: [EMAIL], assistantText: '', personName: undefined }),
    ).toEqual([]);
  });
});

describe('buildNotesMessages', () => {
  it('numbers each result with its source and tells the model that plans are never kept', () => {
    const messages = buildNotesMessages({
      results: [EMAIL],
      assistantText: LONG_REPLY,
      turnDate: '2026-10-29T12:00:00.000Z',
      timeZone: undefined,
    });
    expect(messages[0]?.content).toContain('work plans, intentions, task steps or progress');
    expect(messages[1]?.content).toContain('<result number="1" source="email">');
    expect(messages[1]?.content).toContain('Date of the chat: 2026-10-29');
  });
});

describe('summarizeTurnNotes', () => {
  it('saves a finding from an email result', async () => {
    const { llm } = scriptedLlm(
      JSON.stringify({
        findings: [{ result: 1, text: 'Priya asked for the signed form by 2026-11-03.' }],
        responses: [],
      }),
    );
    expect(await run({ results: [EMAIL], assistantText: 'Done.', llm })).toEqual([
      { source: 'email', text: 'Priya asked for the signed form by 2026-11-03.' },
    ]);
  });

  it('makes no model call for a turn with no tool results and a short reply', async () => {
    const { llm, calls } = scriptedLlm('{"findings": [], "responses": []}');
    expect(await run({ results: [], assistantText: 'Sure, noted.', llm })).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('saves nothing when the reply is only a work plan', async () => {
    const { llm } = scriptedLlm(
      JSON.stringify({
        findings: [],
        responses: ["I'll make two more edits to the plan.", 'Next I will search the web for the form.'],
      }),
    );
    const plan =
      "I'll make two more edits to the plan, then next I will search the web for the form. After that I will update the checklist and report back.";
    expect(await run({ results: [], assistantText: plan, llm })).toEqual([]);
  });

  it('returns no notes when the model call fails', async () => {
    const llm: ILLM = {
      create: () => {
        throw new Error('streaming is not used');
      },
      createNonStream: () => Promise.reject(new Error('model down')),
    };
    expect(await run({ results: [EMAIL], assistantText: LONG_REPLY, llm })).toEqual([]);
  });
});
