/**
 * Sorting what a turn saved: it starts after the save, never holds up the save or the reply, uses the
 * summarizer's model, and leaves private chats alone.
 */
import type { ILLM } from '@truefoundry/trueforge-core/core';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import { readHandledNotes } from '../../../../src/runtime/memory/handledNotes';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { USER_STATED_ORIGIN } from '../../../../src/runtime/memory/memoryOrigin';
import {
  submitRetain,
  type SubmitRetainParams,
  type SummarizeTurnContext,
} from '../../../../src/runtime/memory/memoryRetain';
import { SORT_REPORT_FILE } from '../../../../src/runtime/memory/pageSortReport';
import { saveSentMail } from '../../../../src/runtime/memory/sentMail';
import { MEMORY_PAGE_SORTING_SETTING_KEY } from '../../../../src/runtime/memoryPageSortingSettings';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

let sortingMode: 'off' | 'report' | 'on' = 'on';

jest.mock('../../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../../src/config')>('../../../../src/config');
  return {
    __esModule: true,
    ...actual,
    default: new Proxy(actual.default, {
      get: (target, property, receiver) =>
        property === 'MEMORY_PAGE_SORTING' ? sortingMode : Reflect.get(target, property, receiver),
    }),
  };
});

const SORT_SYSTEM = 'You sort one saved note onto the pages';
const SHELLFISH = 'Wendy is allergic to shellfish.';

interface Model {
  llm: ILLM;
  sortCalls: number;
}

/** A model that answers the summary question with one fact and the sorting question with `sortAnswer`. */
function fakeModel({ sortAnswer }: { sortAnswer: () => Promise<string> }): Model {
  const model: Model = {
    sortCalls: 0,
    llm: {
      create(): ReturnType<ILLM['create']> {
        throw new Error('streaming is not used');
      },
      createNonStream: async body => {
        const system = JSON.stringify(body.messages[0]);
        let content: string;
        if (system.includes(SORT_SYSTEM)) {
          model.sortCalls += 1;
          content = await sortAnswer();
        } else {
          content = JSON.stringify({ facts: [SHELLFISH] });
        }
        return {
          output: { role: 'assistant', content },
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          finish_reason: 'stop',
        };
      },
    },
  };
  return model;
}

function summarizeContext(model: Model, globalSettingsStore = inMemoryGlobalSettingsStore()): SummarizeTurnContext {
  const store: IModelProviderStore = {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
    recordProviderCheck: jest.fn(),
    managedElsewhere: false,
  };
  return {
    tenantId: 'tenant-1',
    modelProviderStore: store,
    summarizationModelFqn: 'test/model',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    globalSettingsStore,
    modelUsage: discardedModelUsage,
    resolveLlm: () => Promise.resolve(model.llm),
  };
}

async function openClient(): Promise<{ client: MarkdownMemoryClient; vaultDir: string }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'retain-sort-'));
  const client = new MarkdownMemoryClient({ baseDir, namespace: 'vault' });
  return { client, vaultDir: client.pagesWriteDir() };
}

// Every chat here is the person speaking.
const TURN: Pick<SubmitRetainParams, 'sessionId' | 'turnId' | 'completedAt' | 'origin'> = {
  sessionId: 's1',
  turnId: 't1',
  completedAt: '2026-11-06T12:00:00.000Z',
  origin: USER_STATED_ORIGIN,
};
const logger = winston.createLogger({ silent: true });

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > 10_000) {
      throw new Error('Gave up waiting.');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const newFactAnswer = () =>
  Promise.resolve(
    JSON.stringify({
      decisions: [
        {
          decision: 'new',
          about: 'wendy',
          page_kind: 'person',
          title: 'Wendy',
          section: 'Now',
          text: SHELLFISH,
          reason: 'The person said it.',
        },
      ],
    }),
  );

async function handledCount(vaultDir: string): Promise<number> {
  return (await readHandledNotes(vaultDir)).size;
}

describe('sorting after a save', () => {
  beforeEach(() => {
    sortingMode = 'on';
  });

  it('puts the saved note on a page, without holding up the save', async () => {
    const { client, vaultDir } = await openClient();
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const model = fakeModel({ sortAnswer: () => held.then(newFactAnswer) });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });

    // The save is done while the sorting call is still waiting.
    expect(await handledCount(vaultDir)).toBe(0);
    await waitFor(() => Promise.resolve(model.sortCalls === 1));
    release();
    await waitFor(async () => (await handledCount(vaultDir)) === 1);
    expect(await readFile(path.join(vaultDir, 'people', 'wendy.md'), 'utf8')).toContain(SHELLFISH);
    expect([...(await readHandledNotes(vaultDir)).values()]).toEqual(['page']);
  });

  it('writes no page in report mode, only a line in the report', async () => {
    sortingMode = 'report';
    const { client, vaultDir } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });

    await waitFor(async () =>
      readFile(path.join(vaultDir, SORT_REPORT_FILE), 'utf8').then(
        () => true,
        () => false,
      ),
    );
    expect(await handledCount(vaultDir)).toBe(0);
    await expect(readFile(path.join(vaultDir, 'people', 'wendy.md'), 'utf8')).rejects.toThrow();
  });

  it('never calls the model for the sorter when sorting is off', async () => {
    sortingMode = 'off';
    const { client } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(model.sortCalls).toBe(0);
  });

  it('asks the model nothing when nothing is stored and the default is off', async () => {
    sortingMode = 'off';
    const { client } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(model.sortCalls).toBe(0);
  });

  it('follows the stored setting over the default, on the very next save, without a restart', async () => {
    sortingMode = 'off';
    const settings = inMemoryGlobalSettingsStore();
    const { client, vaultDir } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });
    const submit = (turnId: string) =>
      submitRetain({
        client,
        session: { is_incognito: false },
        ...TURN,
        turnId,
        userText: `${SHELLFISH} (${turnId})`,
        assistantText: 'Noted.',
        logger,
        summarize: summarizeContext(model, settings),
      });

    await submit('t1');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(model.sortCalls).toBe(0);

    await settings.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'on' });
    await submit('t2');
    await waitFor(async () => (await handledCount(vaultDir)) >= 1);
    expect(model.sortCalls).toBe(1);

    sortingMode = 'on';
    await settings.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: 'off' });
    await submit('t3');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(model.sortCalls).toBe(1);
  });

  it('keeps the note of a reply that wrote to the pages itself, and never sends it to the sorter', async () => {
    const { client, vaultDir } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      chatWrotePages: true,
      logger,
      summarize: summarizeContext(model),
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(model.sortCalls).toBe(0);
    expect(await readFile(path.join(vaultDir, 'memory', '2026-11-06.md'), 'utf8')).toContain(SHELLFISH);
    expect([...(await readHandledNotes(vaultDir)).values()]).toEqual(['chat']);
    await expect(readFile(path.join(vaultDir, 'people', 'wendy.md'), 'utf8')).rejects.toThrow();
  });

  it('records that note as filed by the chat with sorting off too, so turning sorting on later does not sort it', async () => {
    sortingMode = 'off';
    const { client, vaultDir } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      chatWrotePages: true,
      logger,
      summarize: summarizeContext(model),
    });

    expect([...(await readHandledNotes(vaultDir)).values()]).toEqual(['chat']);
  });

  it('sorts nothing from a private chat, which saves nothing', async () => {
    const { client } = await openClient();
    const model = fakeModel({ sortAnswer: newFactAnswer });

    await submitRetain({
      client,
      session: { is_incognito: true },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(model.sortCalls).toBe(0);
  });

  it('keeps the note in the log, unsorted, when the sorting call fails', async () => {
    const { client, vaultDir } = await openClient();
    const model = fakeModel({ sortAnswer: () => Promise.reject(new Error('the model is down')) });

    await submitRetain({
      client,
      session: { is_incognito: false },
      ...TURN,
      userText: SHELLFISH,
      assistantText: 'Noted.',
      logger,
      summarize: summarizeContext(model),
    });
    await waitFor(() => Promise.resolve(model.sortCalls === 1));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(await handledCount(vaultDir)).toBe(0);
    expect(await readFile(path.join(vaultDir, 'memory', '2026-11-06.md'), 'utf8')).toContain(SHELLFISH);
  });

  it('sorts a saved sent message, and sorts nothing when no model is configured', async () => {
    const { client, vaultDir } = await openClient();
    const mail = {
      kind: 'send' as const,
      recipients: ['wendy@example.com'],
      cc: [],
      bcc: [],
      subject: 'Lisbon',
      body: 'W, your train is the 7:40. x',
    };
    const common = {
      client,
      session: { is_incognito: false },
      sessionId: 's1',
      turnId: 't1',
      threadId: 'th',
      mail,
      sentAt: '2026-11-06T12:00:00.000Z',
      timeZone: 'UTC',
      logger,
    };

    await saveSentMail({ ...common, callId: 'c1' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await handledCount(vaultDir)).toBe(0);

    const model = fakeModel({
      sortAnswer: () =>
        Promise.resolve(
          JSON.stringify({
            decisions: [
              {
                decision: 'new',
                about: 'wendy',
                page_kind: 'person',
                title: 'Wendy',
                section: 'How you write to them',
                text: 'Opens with "W," and signs off "x".',
                reason: 'A sent message.',
              },
            ],
          }),
        ),
    });
    await saveSentMail({ ...common, callId: 'c2', summarize: summarizeContext(model) });
    await waitFor(async () => (await handledCount(vaultDir)) === 1);
    expect(await readFile(path.join(vaultDir, 'people', 'wendy.md'), 'utf8')).toContain('src=sent_mail');
  });
});
