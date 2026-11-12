import { execFileRunner, type ILLM } from '@truefoundry/trueforge-core/core';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';

import type { IModelProviderStore } from '../../../../src/db/modelProviderStore';
import type { SummarizeTurnContext } from '../../../../src/runtime/memory/memoryRetain';
import { discardedModelUsage } from '../../../fixtures/discardedModelUsage';
import { inMemoryGlobalSettingsStore } from '../../../fixtures/inMemoryGlobalSettingsStore';
import { uncappedTokenFactoryBudget } from '../../../fixtures/uncappedTokenFactoryBudget';

import { ERASED_ENTRY, namespaceDirFor } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { PageChangeOptions } from '../../../../src/runtime/memory/memoryPageWriter';
import { pagePath, readMemoryPage, type MemoryPage, type PageKind } from '../../../../src/runtime/memory/memoryPages';
import type { SortModel } from '../../../../src/runtime/memory/pageSorter';
import { VAULT_HISTORY_DIR } from '../../../../src/runtime/memory/vaultGit';
import { writePageFile } from './pageFixtures';

export const NAMESPACE = 'default';

/** The server's clock, set to 03:00 on 2026-11-11 in the server's own time zone. */
export const NIGHT = new Date(2026, 10, 11, 3, 0, 0);
export const TODAY = '2026-11-11';

export const silentLogger = createLogger({ silent: true });

export async function makeBase(): Promise<{ baseDir: string; vaultDir: string }> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'nightly-'));
  const vaultDir = namespaceDirFor(baseDir, NAMESPACE);
  await mkdir(vaultDir, { recursive: true });
  return { baseDir, vaultDir };
}

export function changeOptions(vaultDir: string, today = TODAY): PageChangeOptions {
  let n = 0;
  return {
    vaultDir,
    runner: execFileRunner,
    today,
    logger: silentLogger,
    newId: () => {
      n += 1;
      return `f_n${String(n)}`;
    },
  };
}

export const writePage = (vaultDir: string, kind: PageKind, slug: string, content: string) =>
  writePageFile({ vaultDir, kind, slug, content });

export const readPage = (vaultDir: string, kind: PageKind, slug: string) =>
  readFile(pagePath({ vaultDir, kind, slug }), 'utf8');

/** A page with the given lines under "Now" and "Unconfirmed". */
export function pageWith({
  title = 'Wendy',
  now = [],
  unconfirmed = [],
  open = [],
}: {
  title?: string;
  now?: string[];
  unconfirmed?: string[];
  open?: string[];
}): string {
  return [
    '---',
    'kind: matter',
    `title: ${title}`,
    '---',
    `# ${title}`,
    '',
    '## Now',
    ...now,
    '',
    '## Open',
    ...open,
    '',
    '## Unconfirmed',
    ...unconfirmed,
    '',
    '## Earlier',
    '',
  ].join('\n');
}

/** Writes a daily log from the notes' texts, one entry each, as a note the person said: each closes with "From you". */
export async function writeDay({ vaultDir, day, notes }: { vaultDir: string; day: string; notes: string[] }) {
  const dir = path.join(vaultDir, 'memory');
  await mkdir(dir, { recursive: true });
  const body = notes
    .map(
      (text, index) =>
        `## ${day}T0${String(index)}:00:00.000Z\n\n${text}${text === ERASED_ENTRY ? '' : '\n\n> From you'}`,
    )
    .join('\n\n');
  await writeFile(path.join(dir, `${day}.md`), `${body}\n`);
}

export const noteId = (day: string, index: number) => `md:${NAMESPACE}:${day}.md#${String(index)}`;

export function history(vaultDir: string): string[] {
  try {
    return execFileSync(
      'git',
      [`--git-dir=${path.join(vaultDir, VAULT_HISTORY_DIR)}`, 'log', '--format=%s', '--reverse'],
      {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '' },
      },
    )
      .trim()
      .split('\n')
      .filter(line => line !== '');
  } catch {
    return [];
  }
}

/** A model that answers every question with the reply the function gives for it, and keeps the prompts it was asked. */
export function modelAnswering(answer: (prompt: string) => unknown): SortModel & { prompts: string[] } {
  const prompts: string[] = [];
  const model: SortModel = messages => {
    const prompt = messages.map(message => message.content).join('\n');
    prompts.push(prompt);
    const reply = answer(prompt);
    return Promise.resolve({ ok: true, reply: typeof reply === 'string' ? reply : JSON.stringify(reply) });
  };
  return Object.assign(model, { prompts });
}

export const IGNORE_ALL = { decisions: [{ decision: 'ignore', reason: 'Nothing.' }] };

/** The page as the code reads it; the test fails when there is no such page. */
export async function readPageForTest(vaultDir: string, kind: PageKind, slug: string): Promise<MemoryPage> {
  const page = await readMemoryPage({ vaultDir, kind, slug });
  if (page === undefined) {
    throw new Error(`No page ${kind}/${slug}`);
  }
  return page;
}

/**
 * What the summary model needs, with a fake model that answers every question with what `answer` gives for the
 * question's text. Nothing here reaches a real model.
 */
export function fakeSummarize(answer: (prompt: string) => unknown): SummarizeTurnContext {
  const store: IModelProviderStore = {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
    managedElsewhere: false,
  };
  const llm: ILLM = {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used');
    },
    createNonStream: async body => {
      const prompt = body.messages
        .map(message => (typeof message.content === 'string' ? message.content : ''))
        .join('\n');
      const reply = await answer(prompt);
      return {
        output: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      };
    },
  };
  return {
    tenantId: 't',
    modelProviderStore: store,
    summarizationModelFqn: 'test/model',
    tokenFactoryBudget: uncappedTokenFactoryBudget,
    globalSettingsStore: inMemoryGlobalSettingsStore(),
    modelUsage: discardedModelUsage,
    resolveLlm: () => Promise.resolve(llm),
  };
}
